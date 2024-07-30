import * as vscode from 'vscode';
import { join } from 'path';
import { promises as fs } from 'fs';
import * as nodeFs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as path from 'path';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

// Define the compilers
enum KnownExternalCompilers {
  TSLPATCHER = 'TSLPatcher',
  KOTOR_TOOL = 'KotorTool',
  V1 = 'v1.3'
}

interface ExternalCompilerConfig {
  sha256: string;
  name: string;
  releaseDate: Date;
  author: string;
  commandline: { [key: string]: string[] };
}

const COMPILERS: { [key in KnownExternalCompilers]: ExternalCompilerConfig } = {
  [KnownExternalCompilers.TSLPATCHER]: {
    sha256: "539EB689D2E0D3751AEED273385865278BEF6696C46BC0CAB116B40C3B2FE820",
    name: "TSLPatcher",
    releaseDate: new Date(2009, 0, 1),
    author: "todo",
    commandline: {
      "compile": ["-c", "{source}", "-o", "{output}"],
      "decompile": ["-d", "{source}", "-o", "{output}"]
    }
  },
  [KnownExternalCompilers.KOTOR_TOOL]: {
    sha256: "E36AA3172173B654AE20379888EDDC9CF45C62FBEB7AB05061C57B52961C824D",
    name: "Kotor Tool",
    releaseDate: new Date(2005, 0, 1),
    author: "Fred Tetra",
    commandline: {
      "compile": ["-c", "--outputdir", "{output_dir}", "-o", "{output_name}", "-g", "{game_value}", "{source}"],
      "decompile": ["-d", "--outputdir", "{output_dir}", "-o", "{output_name}", "-g", "{game_value}", "{source}"]
    }
  },
  [KnownExternalCompilers.V1]: {
    sha256: "EC3E657C18A32AD13D28DA0AA3A77911B32D9661EA83CF0D9BCE02E1C4D8499D",
    name: "v1.3 first public release",
    releaseDate: new Date(2003, 11, 31),
    author: "todo",
    commandline: {
      "compile": ["-c", "{source}", "{output}"],
      "decompile": ["-d", "{source}", "{output}"]
    }
  }
};

// Function to generate hash for a given file
async function generateHash(filePath: string, algorithm = 'sha256'): Promise<string> {
  const fileBuffer = await fs.readFile(filePath);
  const hashSum = crypto.createHash(algorithm);
  hashSum.update(fileBuffer);
  return hashSum.digest('hex').toUpperCase();
}

// Function to get compiler config by sha256 hash
function getCompilerConfig(sha256: string): ExternalCompilerConfig {
  const compiler = Object.values(COMPILERS).find(c => c.sha256 === sha256);
  if (!compiler) {
    throw new Error(`No compiler found with sha256 hash '${sha256}'`);
  }
  return compiler;
}

class NwnnsscompConfig {
  sha256_hash: string;
  source_file: string;
  output_file: string;
  output_dir: string;
  output_name: string;
  game: number;
  chosen_compiler: ExternalCompilerConfig;

  constructor(sha256_hash: string, sourcefile: string, outputfile: string, game: number) {
    this.sha256_hash = sha256_hash;
    this.source_file = sourcefile;
    this.output_file = outputfile;
    this.output_dir = path.dirname(outputfile);
    this.output_name = path.basename(outputfile);
    this.game = game;
    this.chosen_compiler = getCompilerConfig(sha256_hash);
  }

  get_compile_args(executable: string): string[] {
    return this._format_args(this.chosen_compiler.commandline["compile"], executable);
  }

  get_decompile_args(executable: string): string[] {
    return this._format_args(this.chosen_compiler.commandline["decompile"], executable);
  }

  _format_args(args_list: string[], executable: string): string[] {
    const formatted_args: string[] = args_list.map(arg =>
      arg.replace("{source}", this.source_file)
        .replace("{output}", this.output_file)
        .replace("{output_dir}", this.output_dir)
        .replace("{output_name}", this.output_name)
        .replace("{game_value}", this.game.toString())
    );
    formatted_args.unshift(executable);
    return formatted_args;
  }
}

class ExternalNCSCompiler {
  nwnnsscomp_path: string;
  filehash: string;

  constructor(nwnnsscomp_path: string) {
    this.nwnnsscomp_path = nwnnsscomp_path;
    this.filehash = '';
    this.init();
  }

  async init() {
    await this.change_nwnnsscomp_path(this.nwnnsscomp_path);
  }

  get_info(): ExternalCompilerConfig {
    return getCompilerConfig(this.filehash);
  }

  async change_nwnnsscomp_path(nwnnsscomp_path: string) {
    this.nwnnsscomp_path = nwnnsscomp_path;
    this.filehash = (await generateHash(this.nwnnsscomp_path)).toUpperCase();
  }

  config(source_file: string, output_file: string, game: number, debug = false): NwnnsscompConfig {
    return new NwnnsscompConfig(this.filehash, source_file, output_file, game);
  }

  async compile_script(source_file: string, output_file: string, game: number, timeout = 5, debug = false): Promise<[string, string]> {
    const config = this.config(source_file, output_file, game, debug);
    const result = await this.run_process(config.get_compile_args(this.nwnnsscomp_path), timeout);
    this.check_include_file(result[0]);
    return result;
  }

  async decompile_script(source_file: string, output_file: string, game: number, timeout = 5): Promise<[string, string]> {
    const config = this.config(source_file, output_file, game);
    const result = await this.run_process(config.get_decompile_args(this.nwnnsscomp_path), timeout);
    return result;
  }

  async run_process(args: string[], timeout: number): Promise<[string, string]> {
    return new Promise((resolve, reject) => {
      const child = execFile(args[0], args.slice(1), { timeout: timeout * 1000 }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve([stdout, stderr]);
        }
      });
    });
  }

  check_include_file(output: string) {
    if (output.includes("File is an include file, ignored")) {
      throw new Error("This file has no entry point and cannot be compiled (Most likely an include file).");
    }
  }
}

async function readTasksJson(): Promise<any> {
  const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;
  const tasksJsonPath = workspaceFolder ? join(workspaceFolder, '.vscode', 'tasks.json') : undefined;
  if (!tasksJsonPath) {
    vscode.window.showErrorMessage('No workspace folder found.');
    return null;
  }
  try {
    const tasksJson = await fs.readFile(tasksJsonPath, 'utf8');
    return JSON.parse(tasksJson);
  } catch (error) {
    return null; // No tasks.json found or failed to read
  }
}

// Function to get the path to the nwnnsscomp executable
async function getNwnnsscompPath(): Promise<string | undefined> {
  const nwnnsscompPath = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Select nwnnsscomp executable'
  });

  if (nwnnsscompPath && nwnnsscompPath.length > 0) {
    return nwnnsscompPath[0].fsPath;
  }

  return await vscode.window.showInputBox({
    placeHolder: 'Enter the path to the nwnnsscomp executable',
    validateInput: text => text.trim() === '' ? 'nwnnsscomp path is required' : null
  });
}

// Function to get the source file path
async function getSourceFilePath(): Promise<string | undefined> {
  const sourceFile = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'NWScript Files': ['nss'] },
    openLabel: 'Select source file (.nss)'
  });

  if (sourceFile && sourceFile.length > 0) {
    return sourceFile[0].fsPath;
  }

  return await vscode.window.showInputBox({
    placeHolder: 'Enter the source file path (.nss)',
    validateInput: text => text.trim() === '' ? 'Source file path is required' : null
  });
}

async function getAdditionalArgs(compilerInfo: ExternalCompilerConfig, outputFile: string): Promise<{ [key: string]: string }> {
  const additionalArgs: { [key: string]: string } = {};

  if (compilerInfo.commandline.compile.some(arg => arg.includes('{game_value}'))) {
    const game = await vscode.window.showInputBox({
      placeHolder: 'Enter the game value',
      validateInput: text => isNaN(Number(text)) ? 'Game value must be a number' : null
    });

    if (!game) {
      vscode.window.showErrorMessage('Game value is required.');
      return additionalArgs;
    }

    additionalArgs['game_value'] = game;
  }

  if (compilerInfo.commandline.compile.some(arg => arg.includes('{output_dir}'))) {
    const outputDir = path.dirname(outputFile);
    additionalArgs['output_dir'] = outputDir;
  }

  if (compilerInfo.commandline.compile.some(arg => arg.includes('{output_name}'))) {
    const outputName = path.basename(outputFile);
    additionalArgs['output_name'] = outputName;
  }

  return additionalArgs;
}

async function getTaskType(): Promise<string | undefined> {
  const taskTypes = ['Build Active File', 'Build Specific File', 'Build Folder'];
  return await vscode.window.showQuickPick(taskTypes, {
    placeHolder: 'Select the task type to create'
  });
}

async function setupTasksJson(context: vscode.ExtensionContext) {
  const taskType = await getTaskType();
  if (!taskType) {
    vscode.window.showErrorMessage('Task type selection is required.');
    return;
  }

  const nwnnsscompPath = await getNwnnsscompPath();
  if (!nwnnsscompPath) {
    vscode.window.showErrorMessage('nwnnsscomp path is required.');
    return;
  }

  const compiler = new ExternalNCSCompiler(nwnnsscompPath);
  await compiler.init();
  const compilerInfo = compiler.get_info();

  let sourceFile: string | undefined;
  let outputFile: string | undefined;
  let folderPath: string | undefined;
  let additionalArgs: { [key: string]: string } = {};

  switch (taskType) {
    case 'Build Active File':
      // Placeholder source file since actual file will be active document
      sourceFile = '{file}';
      outputFile = sourceFile.replace(/\.nss$/, ".ncs");
      additionalArgs = await getAdditionalArgs(compilerInfo, outputFile);
      break;
    case 'Build Specific File':
      sourceFile = await getSourceFilePath();
      if (!sourceFile) {
        vscode.window.showErrorMessage('Source file path is required.');
        return;
      }
      outputFile = sourceFile.replace(/\.nss$/, ".ncs");
      additionalArgs = await getAdditionalArgs(compilerInfo, outputFile);
      break;
    case 'Build Folder':
      const folderUri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
      if (!folderUri || folderUri.length === 0) {
        vscode.window.showErrorMessage('No folder selected.');
        return;
      }
      folderPath = folderUri[0].fsPath;
      outputFile = path.join(folderPath, 'compiled');
      additionalArgs = await getAdditionalArgs(compilerInfo, outputFile);
      break;
  }

  if (!sourceFile && !folderPath) {
    vscode.window.showErrorMessage('Source file or folder path is required.');
    return;
  }
  const config: NwnnsscompConfig = new NwnnsscompConfig(
    compilerInfo.sha256,
    sourceFile || '',
    outputFile || '',
    Number(additionalArgs['game_value'] || 1)
  );
  const task = {
    label: `${compilerInfo.name} ${taskType}`,
    type: 'shell',
    command: taskType === 'Build Folder'
      ? `for %f in (${folderPath}\\*.nss) do ${nwnnsscompPath} ${config.get_compile_args(nwnnsscompPath).slice(1).join(' ')}`
      : config.get_compile_args(nwnnsscompPath),
    group: 'build',
    problemMatcher: [],
    presentation: {
      echo: true,
      reveal: 'always',
      focus: false,
      panel: 'shared'
    }
  };

  const tasksJson = {
    version: '2.0.0',
    tasks: [task]
  };

  const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder found.');
    return;
  }
  
  const vscodeFolderPath = join(workspaceFolder, '.vscode');
  const tasksJsonPath = join(vscodeFolderPath, 'tasks.json');
  
  try {
    await fs.mkdir(vscodeFolderPath, { recursive: true });
    if (!nodeFs.existsSync(tasksJsonPath)) {
      await fs.writeFile(tasksJsonPath, JSON.stringify({ version: '2.0.0', tasks: [] }, null, 2));
    }
  } catch (error) {
    vscode.window.showErrorMessage('Error creating .vscode folder or tasks.json file.');
    return;
  }

  await fs.writeFile(tasksJsonPath, JSON.stringify(tasksJson, null, 2));
  vscode.window.showInformationMessage('Tasks.json has been set up successfully.');
}

async function buildActiveFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active file to build.');
    return;
  }

  const document = editor.document;
  const sourceFile = document.uri.fsPath;
  const outputFile = sourceFile.replace(/\.nss$/, ".ncs"); // Change extension to .ncs

  const tasksConfig = await readTasksJson();
  const nwnnsscompPath = tasksConfig ? tasksConfig.tasks[0].command[0] : await getNwnnsscompPath();

  if (!nwnnsscompPath) {
    vscode.window.showErrorMessage('nwnnsscomp path is required.');
    return;
  }

  const compiler = new ExternalNCSCompiler(nwnnsscompPath);
  await compiler.init();
  const compilerInfo = compiler.get_info();
  const additionalArgs = await getAdditionalArgs(compilerInfo, outputFile);

  try {
    await compiler.compile_script(sourceFile, outputFile, Number(additionalArgs['game_value'] || 1)); // Default game value to 1 if not provided
    vscode.window.showInformationMessage('Compilation successful.');
  } catch (error) {
    vscode.window.showErrorMessage(`Compilation error: ${(error as Error).message}`);
  }
}

// Function to handle building all files in a folder
async function buildFolder() {
  const folderUri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
  if (!folderUri || folderUri.length === 0) {
    vscode.window.showErrorMessage('No folder selected.');
    return;
  }

  const folderPath = folderUri[0].fsPath;
  const outputFolder = path.join(folderPath, 'compiled');
  await fs.mkdir(outputFolder, { recursive: true });

  const files = await fs.readdir(folderPath);
  const sourceFiles = files.filter(file => file.endsWith('.nss'));

  const tasksConfig = await readTasksJson();
  const nwnnsscompPath = tasksConfig ? tasksConfig.tasks[0].command[0] : await getNwnnsscompPath();

  if (!nwnnsscompPath) {
    vscode.window.showErrorMessage('nwnnsscomp path is required.');
    return;
  }

  const compiler = new ExternalNCSCompiler(nwnnsscompPath);
  const compilerInfo = compiler.get_info();
  const additionalArgs = await getAdditionalArgs(compilerInfo, outputFolder);

  for (const sourceFile of sourceFiles) {
    const sourceFilePath = path.join(folderPath, sourceFile);
    const outputFilePath = path.join(outputFolder, sourceFile.replace(/\.nss$/, ".ncs")); // Change extension to .ncs
    try {
      await compiler.compile_script(sourceFilePath, outputFilePath, Number(additionalArgs['game_value'] || 1)); // Default game value to 1 if not provided
      vscode.window.showInformationMessage(`Compiled ${sourceFile} successfully.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Compilation error for ${sourceFile}: ${(error as Error).message}`);
    }
  }
}

// Activate function
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.setupTasksJson', async () => {
      try {
        await setupTasksJson(context);
      } catch (error) {
        vscode.window.showErrorMessage(`Error setting up tasks.json: ${(error as Error).message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.buildActiveFile', async () => {
      try {
        await buildActiveFile();
      } catch (error) {
        vscode.window.showErrorMessage(`Error building active file: ${(error as Error).message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.buildFolder', async () => {
      try {
        await buildFolder();
      } catch (error) {
        vscode.window.showErrorMessage(`Error building folder: ${(error as Error).message}`);
      }
    })
  );

  vscode.window.showInformationMessage('Extension activated successfully.');
}

// Deactivate function
export function deactivate() {
  vscode.window.showInformationMessage('Extension deactivated successfully.');
}