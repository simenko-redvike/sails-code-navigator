import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as recast from "recast";

export class SailsDefinitionProvider implements vscode.DefinitionProvider {
  constructor(definitionPaths: Array<string>) {
    this.loadDefinitions(definitionPaths);
  }
  private definitionModules = new Map<string, string>();
  private isFallbackCheck = false;

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    if (this.isFallbackCheck) {
      return undefined;
    }

    this.isFallbackCheck = true;
    const defaultDefinitions = await vscode.commands.executeCommand<
      vscode.Location[]
    >("vscode.executeDefinitionProvider", document.uri, position);
    this.isFallbackCheck = false;

    // If a definition was found by the default provider, return undefined to avoid duplicate results.
    return defaultDefinitions?.length
      ? undefined
      : this.findCustomDefinition(document, position);
  }

  private loadDefinitions(definitionPaths: Array<string>) {
    if (this.definitionModules.size > 0) {
      return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : "";

    definitionPaths.forEach((definitionPath) => {
      try {
        const directoryPath = path.join(workspaceFolder, definitionPath);

        const definitionFiles = fs.readdirSync(directoryPath);
        definitionFiles.forEach((file) => {
          const moduleName = path.basename(file, ".js");
          this.definitionModules.set(
            moduleName,
            path.join(directoryPath, file)
          );
        });
      } catch (error) {
        console.error(`SailsCodeNavigator: error loading definitions from ${definitionPath}: ${(error as Error).message}.`);
      }
    });
    console.log(
      `SailsCodeNavigator: loaded ${this.definitionModules.size} definitions.`
    );
  }

  private findCustomDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const range = document.getWordRangeAtPosition(position);
    if (!range) {
      return undefined;
    }

    let {
      objectName,
      propertyName,
    }: { objectName: string | undefined; propertyName: string | undefined } =
      this.getIdentifiersToDefine(range, document);

    const definition = this.findDefinitionLocation(objectName, propertyName);
    if (!definition) {
      console.warn(
        `SailsCodeNavigator: definition not found for ${document.getText(
          range
        )}.`
      );
    }
    return definition;
  }

  private getIdentifiersToDefine(
    range: vscode.Range,
    document: vscode.TextDocument
  ) {
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const startColumn = range.start.character;
    const endColumn = range.end.character;

    const targetAst = recast.parse(document.getText(), {
      parser: require("recast/parsers/babel"),
    });
    let targetNode: any;
    let targetNodeParent:
      | undefined
      | { name: string; property: object; object: { name: string } };

    recast.visit(targetAst, {
      visitNode(path) {
        if (targetNode) {
          return false;
        }
        const { node } = path;
        const start = node.loc?.start;
        const end = node.loc?.end;
        if (!start || !end) {
          return this.traverse(path);
        }

        if (start.line > endLine || end.line < startLine) {
          return false;
        }

        if (
          start.line === startLine &&
          end.line === endLine &&
          start.column === startColumn &&
          end.column === endColumn
        ) {
          targetNodeParent = path.parent.node;
          targetNode = node;
        }

        return this.traverse(path);
      },
    });

    let objectName: string | undefined;
    let propertyName: string | undefined;

    if (targetNodeParent?.property === targetNode) {
      propertyName = targetNode?.name;
      objectName = targetNodeParent?.object.name;
    } else {
      objectName = targetNode?.name;
    }
    return { objectName, propertyName };
  }

  private findDefinitionLocation(
    objectName: string | undefined,
    propertyName: string | undefined
  ) {
    if (!objectName) {
      return undefined;
    }
    if (!this.definitionModules.has(objectName)) {
      return undefined;
    }
    const definitionFilePath = this.definitionModules.get(objectName);
    const definitionFileContent = fs.readFileSync(
      definitionFilePath as string,
      "utf8"
    );
    const definitionAst = recast.parse(definitionFileContent, {
      parser: require("recast/parsers/babel"),
    });

    let range: vscode.Range | undefined;

    try {
      recast.visit(definitionAst, {
        visitAssignmentExpression(path) {
          let node: any = path.node;
          if (
            node.left.type === "MemberExpression" &&
            node.left.object.name === "module" &&
            node.left.property.name === "exports"
          ) {
            const sourceNode = node.right.properties.find(
              (p: any) => p.key.name === propertyName
            );
            if (sourceNode) {
              range = new vscode.Range(
                new vscode.Position(
                  sourceNode.key.loc?.start.line - 1 || 0,
                  sourceNode.key.loc?.start.column || 0
                ),
                new vscode.Position(
                  sourceNode.key.loc?.end.line - 1 || 0,
                  sourceNode.key.loc?.end.column || 0
                )
              );
              return false;
            }
            range = new vscode.Range(
              new vscode.Position(
                node.left.loc?.start.line - 1 || 0,
                node.left.loc?.start.column || 0
              ),
              new vscode.Position(
                node.left.loc?.end.line - 1 || 0,
                node.left.loc?.end.column || 0
              )
            );
            return false;
          }

          return this.traverse(path);
        },
      });
    } catch (e) {}

    if (!range) {
      return undefined;
    }

    return new vscode.Location(
      vscode.Uri.file(definitionFilePath as string),
      range
    );
  }
}
