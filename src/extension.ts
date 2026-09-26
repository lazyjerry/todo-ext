import * as vscode from 'vscode';

import { TodoViewProvider } from './views/todoViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.text = '$(checklist) TODO';
  statusBar.tooltip = '開啟 todooo TODO List';
  statusBar.command = 'todooo.open';
  statusBar.show();

  const provider = new TodoViewProvider(context);
  context.subscriptions.push(
    statusBar,
    provider,
    vscode.window.registerWebviewViewProvider(TodoViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('todooo.open', () => vscode.commands.executeCommand(`${TodoViewProvider.viewType}.focus`)),
  );
}

export function deactivate(): void {}
