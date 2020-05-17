'use strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import VSPicgo from './vs-picgo';

function uploadImageFromClipboard(vspicgo: VSPicgo): Promise<string | void | Error> {
  return vspicgo.upload();
}

function pasteImageFromClipboard(vspicgo: VSPicgo): void {
  const editor = getActiveMarkDownEditor();
  editor ? vspicgo.paste() : (() => {})();
}

/*
 *  get active markdown editor
 */
function getActiveMarkDownEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  const hasActiveMDEditor = editor && editor.document.languageId === 'markdown';
  if (!hasActiveMDEditor) {
    vscode.window.showErrorMessage('No active markdown editor!');
    return;
  }
  return hasActiveMDEditor ? editor : undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  const vspicgo = new VSPicgo();
  const disposable = [
    vscode.commands.registerCommand('picgo.uploadImageFromClipboard', () => uploadImageFromClipboard(vspicgo)),
    vscode.commands.registerCommand('markdown-img-paste.paste', function() {
      pasteImageFromClipboard(vspicgo);
    }),
  ];
  context.subscriptions.push(...disposable);
}

export function deactivate() {}
