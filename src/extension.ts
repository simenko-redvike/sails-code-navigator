// @ts-nocheck
import * as vscode from "vscode";
import path from "path";
import * as fs from "fs";
import * as recast from "recast";

const ServicesPath = path.join(vscode.workspace.rootPath || "", "api/services");
const ModelsPath = path.join(vscode.workspace.rootPath || "", "api/models");
const Services = fs.readdirSync(ServicesPath).map((file) => {
  return path.basename(file, ".js");
});
const Models = fs.readdirSync(ModelsPath).map((file) => {
  return path.basename(file, ".js");
});

export function activate(context: vscode.ExtensionContext) {
  const provider = vscode.languages.registerDefinitionProvider(
    { scheme: "file", language: "javascript" },
    new CustomDefinitionProvider()
  );
  context.subscriptions.push(provider);
}

class CustomDefinitionProvider implements vscode.DefinitionProvider {
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

    // If a definition was found by the default provider, return it
    if (defaultDefinitions && defaultDefinitions.length > 0) {
      return defaultDefinitions;
    }
    const customDefinition = this.findCustomDefinition(document, position);

    if (customDefinition) {
      return customDefinition;
    }
  }

  private findCustomDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return undefined;
    }

    const startLine = wordRange.start.line + 1;
    const endLine = wordRange.end.line + 1;
    const startColumn = wordRange.start.character;
    const endColumn = wordRange.end.character;

    const targetAst = recast.parse(document.getText(), {
      parser: require("recast/parsers/babel"),
    });
    let targetNode;
    let targetNodeParent;

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
      propertyName = targetNode.name;
      objectName = targetNodeParent.object.name;
    } else {
      objectName = targetNode?.name;
    }

    function findDefinitionLocation(modulePath, objectName, propertyName) {
      const definitionFilePath = path.join(modulePath, objectName + ".js");
      const definitionFileContent = fs.readFileSync(definitionFilePath, "utf8");
      const sourceAst = recast.parse(definitionFileContent, {
        parser: require("recast/parsers/babel"),
      });
      let lineNumber: number = 0;
      let columnNumber: number = 0;

      try {
        recast.visit(sourceAst, {
          visitAssignmentExpression(path) {
            const { node } = path;
            if (
              node.left.type === "MemberExpression" &&
              node.left.object.name === "module" &&
              node.left.property.name === "exports"
            ) {
              const sourceNode = node.right.properties.find(
                (p) => p.key.name === propertyName
              );
              if (sourceNode) {
                lineNumber = sourceNode.loc?.start.line - 1 || 0;
                columnNumber = sourceNode.key.loc?.start.column || 0;
                return false;
              }
              lineNumber = node.loc?.start.line - 1 || 0;
              columnNumber = node.loc?.start.column || 0;
              return false;
            }
          },
        });
      } catch (e) {}

      return new vscode.Location(
        vscode.Uri.file(definitionFilePath),
        new vscode.Position(lineNumber, columnNumber)
      );
    }

    if (Services.includes(objectName as string)) {
      return findDefinitionLocation(ServicesPath, objectName, propertyName);
    } else if (Models.includes(objectName as string)) {
      return findDefinitionLocation(ModelsPath, objectName, propertyName);
    }
  }
}

export function deactivate() {}
