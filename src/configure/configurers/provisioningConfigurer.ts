import * as fs from 'fs';
import * as Path from 'path';
import * as utils from 'util';
import * as vscode from 'vscode';
import { UserCancelledError } from 'vscode-azureextensionui';
import { ArmRestClient } from '../clients/azure/armRestClient';
import { IProvisioningServiceClient } from "../clients/IProvisioningServiceClient";
import { ProvisioningServiceClientFactory } from "../clients/provisioningServiceClientFactory";
import { sleepForMilliSeconds } from '../helper/commonHelper';
import { ControlProvider } from '../helper/controlProvider';
import { GraphHelper } from '../helper/graphHelper';
import { LocalGitRepoHelper } from '../helper/LocalGitRepoHelper';
import { telemetryHelper } from '../helper/telemetryHelper';
import { ExtendedInputDescriptor, InputDataType } from "../model/Contracts";
import { WizardInputs } from "../model/models";
import { CompletePipelineConfiguration, DraftPipelineConfiguration, File, ProvisioningConfiguration } from "../model/provisioningConfiguration";
import { RemotePipelineTemplate } from '../model/templateModels';
import { Messages } from '../resources/messages';
import { TelemetryKeys } from '../resources/telemetryKeys';
import { TracePoints } from '../resources/tracePoints';
import { InputControl } from '../templateInputHelper/InputControl';
import { IProvisioningConfigurer } from './IProvisioningConfigurer';

// tslint:disable-next-line:interface-name
interface DraftFile {
    content: string;
    path: string;
    absPath: string;
}

const Layer: string = "ProvisioningConfigurer";
export class ProvisioningConfigurer implements IProvisioningConfigurer {
    private provisioningServiceClient: IProvisioningServiceClient;
    private queuedPipelineUrl: string;
    private refreshTime: number = 5 * 1000;
    private localGitRepoHelper: LocalGitRepoHelper;
    private filesToCommit: DraftFile[] = [];

    constructor(localGitRepoHelper: LocalGitRepoHelper){
        this.localGitRepoHelper = localGitRepoHelper;
    }

    public async createProvisioningPipeline(provisioningConfiguration: ProvisioningConfiguration, wizardInputs: WizardInputs): Promise<ProvisioningConfiguration>{
        try {
            this.provisioningServiceClient =  await ProvisioningServiceClientFactory.getClient(wizardInputs.githubPATToken, wizardInputs.azureSession.credentials);
            const OrgAndRepoDetails = wizardInputs.sourceRepository.repositoryId.split('/');
            return await this.provisioningServiceClient.createProvisioningConfiguration(provisioningConfiguration, OrgAndRepoDetails[0], OrgAndRepoDetails[1]);
        } catch (error){
            telemetryHelper.logError(Layer, TracePoints.UnableToCreateProvisioningPipeline, error);
            throw error;
        }
    }

    public async getProvisioningPipeline(jobId: string, githubOrg: string, repository: string, wizardInputs: WizardInputs): Promise<ProvisioningConfiguration>{
       try {
        this.provisioningServiceClient =  await ProvisioningServiceClientFactory.getClient(wizardInputs.githubPATToken, wizardInputs.azureSession.credentials);
        return await this.provisioningServiceClient.getProvisioningConfiguration(jobId, githubOrg, repository);
       } catch (error){
            telemetryHelper.logError(Layer, TracePoints.UnabletoGetProvisioningPipeline, error);
            throw error;
       }
    }

    public async checkProvisioningPipeline(jobId: string, githubOrg: string, repository: string, wizardInputs: WizardInputs): Promise<ProvisioningConfiguration> {
        try {
            const provisioningServiceResponse = await this.getProvisioningPipeline(jobId, githubOrg, repository, wizardInputs);
            if ( provisioningServiceResponse.result){
                if ( provisioningServiceResponse.result.status ===  "Queued" ||  provisioningServiceResponse.result.status == "InProgress") {
                await sleepForMilliSeconds(this.refreshTime);
                return await this.checkProvisioningPipeline(jobId, githubOrg, repository, wizardInputs);
                } else if (provisioningServiceResponse.result.status ===  "Failed") {
                throw new Error(provisioningServiceResponse.result.message) ;
                } else {
                    return provisioningServiceResponse;
                }
            }else {
                throw new Error("Failed to receive queued pipeline provisioning job status");
            }
        } catch (error) {
            throw error;
        }
    }

    public async browseQueuedPipeline(): Promise<void> {
        new ControlProvider().showInformationBox("Browse queued pipeline", Messages.githubWorkflowSetupSuccessfully, Messages.browseWorkflow)
            .then((action: string) => {
                if (action && action.toLowerCase() === Messages.browseWorkflow.toLowerCase()) {
                    telemetryHelper.setTelemetry(TelemetryKeys.BrowsePipelineClicked, 'true');
                    vscode.env.openExternal(vscode.Uri.parse(this.queuedPipelineUrl));
                }
            });
    }

    public async postSteps(provisioningConfiguration: ProvisioningConfiguration, draftPipelineConfiguration: DraftPipelineConfiguration, inputs: WizardInputs): Promise<void> {
        await this.getFileToCommit(draftPipelineConfiguration);
        await this.showPipelineFiles();
        const displayMessage = (this.filesToCommit.length > 1) ?  Messages.modifyAndCommitMultipleFiles : Messages.modifyAndCommitFile;
        const commitOrDiscard = await new ControlProvider().showInformationBox(
            "Commit or discard",
            utils.format(displayMessage, Messages.commitAndPush, inputs.sourceRepository.branch, inputs.sourceRepository.remoteName),
            Messages.commitAndPush,
            Messages.discardPipeline);
        let provisioningServiceResponse: ProvisioningConfiguration;
        if (!!commitOrDiscard && commitOrDiscard.toLowerCase() === Messages.commitAndPush.toLowerCase()) {
             provisioningServiceResponse = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: Messages.configuringPipelineAndDeployment },
             async () => {
                try {
                    provisioningConfiguration.pipelineConfiguration = await this.createFilesToCheckin(draftPipelineConfiguration.id, draftPipelineConfiguration.type);
                    const completeProvisioningSvcResp = await this.createProvisioningPipeline(provisioningConfiguration, inputs);
                    if ( completeProvisioningSvcResp.id != "" ){
                        const OrgAndRepoDetails = inputs.sourceRepository.repositoryId.split('/');
                        return await this.checkProvisioningPipeline(completeProvisioningSvcResp.id, OrgAndRepoDetails[0], OrgAndRepoDetails[1], inputs);
                    } else {
                        throw new Error("Failed to configure pipeline");
                    }
                } catch (error) {
                    telemetryHelper.logError(Layer, TracePoints.RemotePipelineConfiguringFailed, error);
                    vscode.window.showErrorMessage(utils.format(Messages.ConfiguringPipelineFailed, error.message));
                    return null;
                }
            });
        } else {
                telemetryHelper.setTelemetry(TelemetryKeys.PipelineDiscarded, 'true');
                throw new UserCancelledError(Messages.operationCancelled);
        }

        if ( provisioningServiceResponse != undefined) {
            this.setQueuedPipelineUrl(provisioningServiceResponse, inputs);
        } else {
            throw new Error("Failed to configure provisoining pipeline");
        }
    }

    public async showPipelineFiles(): Promise<void> {
        this.filesToCommit.forEach(async (file) => {
            await this.localGitRepoHelper.addContentToFile(file.content, file.absPath);
            await vscode.window.showTextDocument(vscode.Uri.file(file.absPath));
        });
    }

    public setQueuedPipelineUrl(provisioningConfiguration: ProvisioningConfiguration, inputs: WizardInputs){
      const commitId = (provisioningConfiguration.result.pipelineConfiguration as CompletePipelineConfiguration).commitId;
      this.queuedPipelineUrl = `https://github.com/${inputs.sourceRepository.repositoryId}/commit/${commitId}/checks`;
    }

    public async  getFileToCommit(draftPipelineConfiguration: DraftPipelineConfiguration): Promise<void> {
        let destination: string;
        for (const file of draftPipelineConfiguration.files ) {
            destination = await this.getPathToFile(Path.basename(file.path), Path.dirname(file.path));
            const decodedData = new Buffer(file.content, 'base64').toString('utf-8');
            this.filesToCommit.push({absPath: destination, content: decodedData, path: file.path} as DraftFile);
        }
    }

    public async getPathToFile( fileName: string, directory: string) {
        const dirList = directory.split("/"); // Hardcoded as provisioning service is running on linux and we cannot use Path.sep as it is machine dependent
        let directoryPath: string = "";
        directoryPath = await this.localGitRepoHelper.getGitRootDirectory();
        dirList.forEach((dir) => {
            try {
                directoryPath = Path.join(directoryPath, dir);
                // tslint:disable-next-line:non-literal-fs-path
                if (!fs.existsSync(directoryPath)) {
                    // tslint:disable-next-line:non-literal-fs-path
                    fs.mkdirSync(directoryPath);
                }
            }
            catch (error) {
                throw error;
            }
        });
        telemetryHelper.setTelemetry(TelemetryKeys.WorkflowFileName, fileName);
        return Path.join(directoryPath, fileName);
    }

    public async CreatePreRequisiteParams(wizardInputs: WizardInputs): Promise<void>{
        // Create SPN and ACRResource group for reuseACR flow set to false
        const inputDescriptor = this.getInputDescriptor(wizardInputs, "azureAuth");
        if (inputDescriptor != undefined){
            const createResourceGroup = InputControl.getInputDescriptorProperty(inputDescriptor, "createResourceGroup", wizardInputs.pipelineConfiguration.params);
            if ( createResourceGroup.length > 0 && createResourceGroup[0] != "" ){
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: Messages.CreatingACRResourceGroup },
                    async () => {
                        try {
                           return await new ArmRestClient(wizardInputs.azureSession).createResourceGroup(wizardInputs.subscriptionId, createResourceGroup[0], wizardInputs.pipelineConfiguration.params["location"]);
                        } catch (error){
                            telemetryHelper.logError(Layer, TracePoints.ACRResourceGroupCreationFailed, error);
                            throw error;
                        }
                    } );
            }

            const scope = InputControl.getInputDescriptorProperty(inputDescriptor, "scope", wizardInputs.pipelineConfiguration.params);
            if ( scope.length > 0 && scope[0] != "" ){
                wizardInputs.pipelineConfiguration.params["azureAuth"] = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: Messages.CreatingSPN },
                    async () => {
                        try {
                            // TODO: Need to add support for array of scope
                            return await this.getAzureSPNSecret(wizardInputs, scope[0]);
                        } catch (error){
                            telemetryHelper.logError(Layer, TracePoints.SPNCreationFailed, error);
                            throw error;
                        }
                    } );
            }
        } else {
            throw new Error("Input descriptor undefined");
        }

        // Create armAuthToken
        const parsedCredentials = JSON.parse(JSON.stringify(wizardInputs.azureSession.credentials));
        if (parsedCredentials.tokenCache && parsedCredentials.tokenCache.target &&
            parsedCredentials.tokenCache.target._entries[0] && parsedCredentials.tokenCache.target._entries[0].accessToken){
                wizardInputs.pipelineConfiguration.params["armAuthToken"] = "Bearer " + parsedCredentials.tokenCache.target._entries[0].accessToken;
        } else {
            const error =  new Error("Failed to get armAuthToken");
            telemetryHelper.logError(Layer, TracePoints.UndefinedArmAuthToken, error);
            throw error;
        }
    }

    private getInputDescriptor(wizardInputs: WizardInputs, inputId: string ): ExtendedInputDescriptor{
        const template = wizardInputs.pipelineConfiguration.template as RemotePipelineTemplate;
        let inputDataType: InputDataType;
        switch (inputId){
            case "azureAuth":
                inputDataType = InputDataType.Authorization;
                break;
            default:
                 return undefined;
        }

        return template.parameters.inputs.find((value) => (value.type === inputDataType && value.id === inputId));
    }

    private async getAzureSPNSecret(inputs: WizardInputs, scope?: string): Promise<string> {
        const  aadAppName = GraphHelper.generateAadApplicationName(inputs.sourceRepository.remoteName, 'github');
        const aadApp = await GraphHelper.createSpnAndAssignRole(inputs.azureSession, aadAppName, scope);
        return JSON.stringify({
        scheme:  'ServicePrincipal',
        parameters: {
            serviceprincipalid: `${aadApp.appId}`,
            serviceprincipalkey: `${aadApp.secret}`,
            subscriptionId: `${inputs.subscriptionId}`,
            tenantid: `${inputs.azureSession.tenantId}`,
        }
        });
   }

   // tslint:disable-next-line:no-reserved-keywords
   private async createFilesToCheckin(id: string, type: string): Promise<DraftPipelineConfiguration>{
       const files: File[] = [];
       for ( const file of this.filesToCommit){
           const fileContent = await this.localGitRepoHelper.readFileContent(file.absPath);
           const encodedContent = new Buffer(fileContent, 'utf-8').toString('base64');
           files.push({path: file.path, content: encodedContent});
        }

       return {
            id,
            type,
            files,
        } as DraftPipelineConfiguration;
   }
}
