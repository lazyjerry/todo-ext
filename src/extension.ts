import * as vscode from 'vscode';

import { TodoPanel } from './views/todoPanel';

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.text = '$(checklist) TODO';
  statusBar.tooltip = '開啟 todooo TODO List';
  statusBar.command = 'todooo.open';
  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('todooo.open', () => TodoPanel.show(context)),
  );
}

export function deactivate(): void {}
