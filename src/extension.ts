import * as vscode from "vscode";
import { SailsDefinitionProvider } from "./SailsDefinitionProvider";

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("sailsCodeNavigator");
  const definitionPaths = config.get<Array<string>>("definitionPaths");

  const provider = vscode.languages.registerDefinitionProvider(
    { scheme: "file", language: "javascript" },
    new SailsDefinitionProvider(definitionPaths || [])
  );
  context.subscriptions.push(provider);
}

export function deactivate() {}
