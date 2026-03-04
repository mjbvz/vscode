/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getLocation, getNodeValue, parseTree, findNodeAtLocation, visit } from 'jsonc-parser';


const packageJsonSelector: vscode.DocumentSelector = { language: 'json', pattern: '**/package.json' };
const packageNlsJsonSelector: vscode.DocumentSelector = { language: 'json', pattern: '**/package.nls.json' };

export class PackageDocumentL10nSupport implements vscode.DefinitionProvider, vscode.ReferenceProvider, vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = [];

	constructor() {
		this._disposables.push(vscode.languages.registerDefinitionProvider(packageJsonSelector, this));
		this._disposables.push(vscode.languages.registerDefinitionProvider(packageNlsJsonSelector, this));

		this._disposables.push(vscode.languages.registerReferenceProvider(packageNlsJsonSelector, this));
		this._disposables.push(vscode.languages.registerReferenceProvider(packageJsonSelector, this));
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose();
		}
	}

	public async provideDefinition(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken): Promise<vscode.DefinitionLink[] | undefined> {
		const basename = document.uri.path.split('/').pop()?.toLowerCase();
		if (basename === 'package.json') {
			return this.provideNlsValueDefinition(document, position);
		}

		if (basename === 'package.nls.json') {
			return this.provideNlsKeyDefinition(document, position);
		}

		return undefined;
	}

	private async provideNlsValueDefinition(packageJsonDoc: vscode.TextDocument, position: vscode.Position): Promise<vscode.DefinitionLink[] | undefined> {
		const nlsRef = this.getNlsReferenceAtPosition(packageJsonDoc, position);
		if (!nlsRef) {
			return undefined;
		}

		const nlsUri = vscode.Uri.joinPath(packageJsonDoc.uri, '..', 'package.nls.json');
		return this.resolveNlsDefinition(nlsRef, nlsUri);
	}

	private async provideNlsKeyDefinition(nlsDoc: vscode.TextDocument, position: vscode.Position): Promise<vscode.DefinitionLink[] | undefined> {
		const nlsKey = this.getNlsKeyDefinitionAtPosition(nlsDoc, position);
		if (!nlsKey) {
			return undefined;
		}
		return this.resolveNlsDefinition(nlsKey, nlsDoc.uri);
	}

	private async resolveNlsDefinition(origin: { key: string; range: vscode.Range }, nlsUri: vscode.Uri): Promise<vscode.DefinitionLink[] | undefined> {
		const target = await this.findNlsKeyDefinitionTarget(origin.key, nlsUri);
		if (!target) {
			return undefined;
		}

		return [{
			originSelectionRange: origin.range,
			targetUri: target.uri,
			targetRange: target.range,
			targetSelectionRange: target.selectionRange,
		}];
	}

	private getNlsReferenceAtPosition(packageJsonDoc: vscode.TextDocument, position: vscode.Position): { key: string; range: vscode.Range } | undefined {
		const location = getLocation(packageJsonDoc.getText(), packageJsonDoc.offsetAt(position));
		if (!location.previousNode || location.previousNode.type !== 'string') {
			return undefined;
		}

		const value = getNodeValue(location.previousNode);
		if (typeof value !== 'string') {
			return undefined;
		}

		const match = value.match(/^%(.+)%$/);
		if (!match) {
			return undefined;
		}

		return { key: match[1], range: this.rangeFromOffsetAndLength(packageJsonDoc, location.previousNode.offset, location.previousNode.length) };
	}

	public async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, _token: vscode.CancellationToken): Promise<vscode.Location[] | undefined> {
		const basename = document.uri.path.split('/').pop()?.toLowerCase();
		if (basename === 'package.nls.json') {
			return this.provideNlsKeyReferences(document, position, context);
		}
		if (basename === 'package.json') {
			return this.provideNlsValueReferences(document, position, context);
		}
		return undefined;
	}

	private async provideNlsKeyReferences(nlsDoc: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[] | undefined> {
		const nlsKey = this.getNlsKeyDefinitionAtPosition(nlsDoc, position);
		if (!nlsKey) {
			return undefined;
		}

		const packageJsonUri = vscode.Uri.joinPath(nlsDoc.uri, '..', 'package.json');
		return this.findAllNlsReferences(nlsKey.key, packageJsonUri, nlsDoc.uri, context);
	}

	private async provideNlsValueReferences(packageJsonDoc: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[] | undefined> {
		const nlsRef = this.getNlsReferenceAtPosition(packageJsonDoc, position);
		if (!nlsRef) {
			return undefined;
		}

		const nlsUri = vscode.Uri.joinPath(packageJsonDoc.uri, '..', 'package.nls.json');
		return this.findAllNlsReferences(nlsRef.key, packageJsonDoc.uri, nlsUri, context);
	}

	private async findAllNlsReferences(nlsKey: string, packageJsonUri: vscode.Uri, nlsUri: vscode.Uri, context: vscode.ReferenceContext): Promise<vscode.Location[]> {
		const locations = await this.findNlsReferencesInPackageJson(nlsKey, packageJsonUri);

		if (context.includeDeclaration) {
			const decl = await this.findNlsKeyDeclaration(nlsKey, nlsUri);
			if (decl) {
				locations.push(decl);
			}
		}

		return locations;
	}

	private async findNlsKeyDefinitionTarget(nlsKey: string, nlsUri: vscode.Uri): Promise<{ uri: vscode.Uri; range: vscode.Range; selectionRange: vscode.Range } | undefined> {
		try {
			const nlsDoc = await vscode.workspace.openTextDocument(nlsUri);
			const nlsTree = parseTree(nlsDoc.getText());
			if (!nlsTree) {
				return undefined;
			}

			const valueNode = findNodeAtLocation(nlsTree, [nlsKey]);
			if (!valueNode?.parent) {
				return undefined;
			}

			const propertyNode = valueNode.parent;
			const keyNode = propertyNode.children?.[0];
			if (!keyNode) {
				return undefined;
			}

			const targetRange = this.rangeFromOffsetAndLength(nlsDoc, propertyNode.offset, propertyNode.length);
			const targetSelectionRange = this.rangeFromOffsetAndLength(nlsDoc, keyNode.offset, keyNode.length);

			return {
				uri: nlsUri,
				range: targetRange,
				selectionRange: targetSelectionRange,
			};
		} catch {
			return undefined;
		}
	}

	private async findNlsKeyDeclaration(nlsKey: string, nlsUri: vscode.Uri): Promise<vscode.Location | undefined> {
		const target = await this.findNlsKeyDefinitionTarget(nlsKey, nlsUri);
		if (!target) {
			return undefined;
		}

		return new vscode.Location(target.uri, target.selectionRange);
	}

	private async findNlsReferencesInPackageJson(nlsKey: string, packageJsonUri: vscode.Uri): Promise<vscode.Location[]> {
		let packageJsonDoc: vscode.TextDocument;
		try {
			packageJsonDoc = await vscode.workspace.openTextDocument(packageJsonUri);
		} catch {
			return [];
		}

		const text = packageJsonDoc.getText();
		const needle = `%${nlsKey}%`;
		const locations: vscode.Location[] = [];

		visit(text, {
			onLiteralValue: (value, offset, length) => {
				if (value === needle) {
					locations.push(new vscode.Location(packageJsonUri, this.rangeFromOffsetAndLength(packageJsonDoc, offset, length)));
				}
			}
		});

		return locations;
	}

	private getNlsKeyDefinitionAtPosition(nlsDoc: vscode.TextDocument, position: vscode.Position): { key: string; range: vscode.Range } | undefined {
		const location = getLocation(nlsDoc.getText(), nlsDoc.offsetAt(position));

		// Must be on a top-level property key
		if (location.path.length !== 1 || !location.isAtPropertyKey || !location.previousNode) {
			return undefined;
		}

		const key = location.path[0] as string;
		return { key, range: this.rangeFromOffsetAndLength(nlsDoc, location.previousNode.offset, location.previousNode.length) };
	}

	private rangeFromOffsetAndLength(document: vscode.TextDocument, offset: number, length: number): vscode.Range {
		return new vscode.Range(document.positionAt(offset), document.positionAt(offset + length));
	}
}
