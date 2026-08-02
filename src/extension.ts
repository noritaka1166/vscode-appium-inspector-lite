import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

type AppiumResponse<T> = { value?: T; sessionId?: string; status?: number };

interface SessionState {
  id: string;
  serverUrl: string;
}

interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SourceElement {
  tag: string;
  attributes: Record<string, string>;
  x: number;
  y: number;
  width: number;
  height: number;
}

let panel: vscode.WebviewPanel | undefined;
let session: SessionState | undefined;
let output: vscode.OutputChannel;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let latestSource = '';

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Appium Inspector Lite');
  context.subscriptions.push(output);
  context.subscriptions.push(vscode.commands.registerCommand('appiumInspector.open', () => openInspector(context)));
}

function openInspector(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'appiumInspectorLite',
    'Appium Inspector Lite',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);
  panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
  panel.webview.onDidReceiveMessage((message: WebviewMessage) => handleMessage(message), undefined, context.subscriptions);
}

type WebviewMessage =
  | { type: 'startSession'; serverUrl: string; capabilities: string }
  | { type: 'startServer'; serverUrl: string }
  | { type: 'stopServer' }
  | { type: 'showOutput' }
  | { type: 'refresh' }
  | { type: 'findElement'; using: string; value: string }
  | { type: 'selectScreenshotElement'; x: number; y: number; screenshotWidth: number; screenshotHeight: number }
  | { type: 'clickElement'; elementId: string }
  | { type: 'sendKeys'; elementId: string; text: string }
  | { type: 'copy'; text: string }
  | { type: 'quitSession' };

async function handleMessage(message: WebviewMessage): Promise<void> {
  try {
    switch (message.type) {
      case 'startSession':
        await startSession(message.serverUrl, message.capabilities);
        await refreshInspector();
        break;
      case 'startServer':
        await startServer(message.serverUrl);
        break;
      case 'stopServer':
        await stopServer();
        break;
      case 'showOutput':
        output.show(true);
        break;
      case 'refresh':
        await refreshInspector();
        break;
      case 'findElement':
        await findElement(message.using, message.value);
        break;
      case 'selectScreenshotElement':
        await selectScreenshotElement(message.x, message.y, message.screenshotWidth, message.screenshotHeight);
        break;
      case 'clickElement':
        await command(`/element/${encodeURIComponent(message.elementId)}/click`, 'POST', {});
        post({ type: 'notice', level: 'success', text: '要素をタップしました。' });
        await refreshInspector();
        break;
      case 'sendKeys':
        await command(`/element/${encodeURIComponent(message.elementId)}/value`, 'POST', { text: message.text, value: [...message.text] });
        post({ type: 'notice', level: 'success', text: 'テキストを入力しました。' });
        await refreshInspector();
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        post({ type: 'notice', level: 'success', text: 'クリップボードにコピーしました。' });
        break;
      case 'quitSession':
        await quitSession();
        break;
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    output.appendLine(text);
    post({ type: 'notice', level: 'error', text });
  }
}

async function startServer(rawServerUrl: string): Promise<void> {
  if (serverProcess) {
    throw new Error('この拡張機能から起動した Appium Server はすでに動作しています。');
  }

  const serverUrl = normaliseServerUrl(rawServerUrl);
  const url = new URL(serverUrl);
  const permittedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (!permittedHosts.has(url.hostname)) {
    throw new Error('拡張機能から起動できるのはローカル Appium Server のみです。localhost または 127.0.0.1 を指定してください。');
  }
  if (await isServerReachable(serverUrl)) {
    throw new Error('指定した URL ではすでに Appium Server が応答しています。既存のサーバーへ接続してください。');
  }

  const port = url.port || '4723';
  const address = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, '');
  const basePath = url.pathname.replace(/\/$/, '');
  const args = ['--address', address, '--port', port];
  if (basePath && basePath !== '/') {
    args.push('--base-path', basePath);
  }

  output.appendLine(`Appium Server を起動します: appium ${args.join(' ')}`);
  const child = spawn('appium', args, { shell: false });
  serverProcess = child;
  child.stdout.on('data', (data: Buffer) => output.append(data.toString()));
  child.stderr.on('data', (data: Buffer) => output.append(data.toString()));
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (serverProcess === child) {
      serverProcess = undefined;
      postServerState();
    }
    const message = error.code === 'ENOENT'
      ? 'appium コマンドが見つかりません。`npm install -g appium` を実行してから、VS Code を再起動してください。'
      : `Appium Server を起動できませんでした: ${error.message}`;
    output.appendLine(message);
    post({ type: 'notice', level: 'error', text: message });
  });
  child.on('close', (code, signal) => {
    if (serverProcess === child) {
      serverProcess = undefined;
      postServerState();
      const detail = signal ? `シグナル ${signal}` : `終了コード ${code ?? '不明'}`;
      post({ type: 'notice', level: code === 0 ? 'success' : 'error', text: `Appium Server が停止しました（${detail}）。` });
    }
  });

  await waitForServer(serverUrl, child);
  postServerState();
  post({ type: 'notice', level: 'success', text: `Appium Server を起動しました: ${serverUrl}` });
}

async function stopServer(): Promise<void> {
  if (!serverProcess) {
    throw new Error('この拡張機能から起動した Appium Server はありません。');
  }
  output.appendLine('Appium Server を停止します。');
  if (!serverProcess.kill('SIGTERM')) {
    throw new Error('Appium Server の停止要求を送信できませんでした。');
  }
  post({ type: 'notice', level: 'success', text: 'Appium Server の停止を要求しました。' });
}

async function isServerReachable(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/status`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(serverUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    if (serverProcess !== child || child.exitCode !== null) {
      throw new Error('Appium Server が起動直後に停止しました。出力パネルの Appium Inspector Lite ログを確認してください。');
    }
    if (await isServerReachable(serverUrl)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Appium Server の起動がタイムアウトしました。出力パネルの Appium Inspector Lite ログを確認してください。');
}

async function startSession(rawServerUrl: string, rawCapabilities: string): Promise<void> {
  const serverUrl = normaliseServerUrl(rawServerUrl);
  let capabilities: Record<string, unknown>;
  try {
    capabilities = JSON.parse(rawCapabilities) as Record<string, unknown>;
  } catch {
    throw new Error('Capabilities は有効な JSON オブジェクトで指定してください。');
  }
  if (Array.isArray(capabilities) || capabilities === null) {
    throw new Error('Capabilities は JSON オブジェクトで指定してください。');
  }

  const response = await request<AppiumResponse<{ sessionId?: string; capabilities?: unknown }>>(
    `${serverUrl}/session`,
    'POST',
    { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }
  );
  const sessionId = response.value?.sessionId ?? response.sessionId;
  if (!sessionId) {
    throw new Error('Appium から sessionId が返されませんでした。Capabilities とサーバー設定を確認してください。');
  }
  session = { id: sessionId, serverUrl };
  post({ type: 'session', id: sessionId });
  post({ type: 'notice', level: 'success', text: `セッションを開始しました: ${sessionId}` });
}

async function refreshInspector(): Promise<void> {
  ensureSession();
  const [screenshot, source] = await Promise.all([
    command<string>('/screenshot', 'GET'),
    command<string>('/source', 'GET')
  ]);
  latestSource = source;
  post({ type: 'snapshot', screenshot, source });
}

async function findElement(using: string, value: string): Promise<void> {
  if (!value.trim()) {
    throw new Error('検索する locator の値を入力してください。');
  }
  const result = await command<Record<string, string>>('/element', 'POST', { using, value });
  const elementId = result[W3C_ELEMENT_KEY] ?? result.ELEMENT;
  if (!elementId) {
    throw new Error('要素 ID を取得できませんでした。');
  }
  post({ type: 'element', id: elementId, using, value });
  post({ type: 'notice', level: 'success', text: '要素を見つけました。操作または locator のコピーができます。' });
}

async function selectScreenshotElement(rawX: number, rawY: number, screenshotWidth: number, screenshotHeight: number): Promise<void> {
  if (!latestSource) {
    throw new Error('Page Source が未取得です。画面を更新してから、スクリーンショット上の要素を選択してください。');
  }
  if (screenshotWidth <= 0 || screenshotHeight <= 0) {
    throw new Error('スクリーンショットのサイズを取得できませんでした。画面を更新してください。');
  }

  const rect = await command<WindowRect>('/window/rect', 'GET');
  const x = Math.round(rect.x + (rawX / screenshotWidth) * rect.width);
  const y = Math.round(rect.y + (rawY / screenshotHeight) * rect.height);
  const candidates = parseSourceElements(latestSource)
    .filter((element) => x >= element.x && x <= element.x + element.width && y >= element.y && y <= element.y + element.height)
    .sort((a, b) => (a.width * a.height) - (b.width * b.height));
  const selected = candidates[0];
  if (!selected) {
    throw new Error('クリック位置に対応する要素を Page Source から見つけられませんでした。Canvas や画像のみで構成された領域では要素を取得できません。');
  }

  for (const locator of getLocators(selected)) {
    try {
      const result = await command<Record<string, string>>('/element', 'POST', locator);
      const elementId = result[W3C_ELEMENT_KEY] ?? result.ELEMENT;
      if (elementId) {
        post({ type: 'element', id: elementId, using: locator.using, value: locator.value, tag: selected.tag });
        post({ type: 'notice', level: 'success', text: `${selected.tag} を選択しました（${locator.using}）。` });
        return;
      }
    } catch {
      // 属性の候補を順に試す。次の locator で見つかることがある。
    }
  }
  throw new Error('画面上の要素は特定できましたが、再取得できる locator を生成できませんでした。Page Source の属性を確認してください。');
}

function parseSourceElements(source: string): SourceElement[] {
  const elements: SourceElement[] = [];
  const tags = /<([A-Za-z0-9_.:-]+)\b([^>]*)\/?\s*>/g;
  for (const match of source.matchAll(tags)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[2].matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
      attributes[attribute[1]] = decodeXml(attribute[2]);
    }
    const box = getElementBox(attributes);
    if (box && box.width > 0 && box.height > 0) {
      elements.push({ tag: match[1], attributes, ...box });
    }
  }
  return elements;
}

function getElementBox(attributes: Record<string, string>): Omit<SourceElement, 'tag' | 'attributes'> | undefined {
  const androidBounds = attributes.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (androidBounds) {
    const [, left, top, right, bottom] = androidBounds.map(Number);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  const x = Number(attributes.x);
  const y = Number(attributes.y);
  const width = Number(attributes.width);
  const height = Number(attributes.height);
  if ([x, y, width, height].every(Number.isFinite)) {
    return { x, y, width, height };
  }
  return undefined;
}

function getLocators(element: SourceElement): Array<{ using: string; value: string }> {
  const { attributes } = element;
  const locators: Array<{ using: string; value: string }> = [];
  const add = (using: string, value: string | undefined): void => {
    if (value && !locators.some((locator) => locator.using === using && locator.value === value)) {
      locators.push({ using, value });
    }
  };
  add('accessibility id', attributes['content-desc']);
  add('id', attributes['resource-id']);
  add('accessibility id', attributes.name);
  add('accessibility id', attributes.label);
  if (attributes.text) {
    add('xpath', `//*[@text=${xpathLiteral(attributes.text)}]`);
  }
  if (attributes.bounds) {
    add('xpath', `//*[@bounds=${xpathLiteral(attributes.bounds)}]`);
  } else if (attributes.x && attributes.y && attributes.width && attributes.height) {
    add('xpath', `//*[@x=${xpathLiteral(attributes.x)} and @y=${xpathLiteral(attributes.y)} and @width=${xpathLiteral(attributes.width)} and @height=${xpathLiteral(attributes.height)}]`);
  }
  return locators;
}

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  return `concat(${value.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
}

async function quitSession(): Promise<void> {
  if (!session) {
    return;
  }
  await request(`${session.serverUrl}/session/${encodeURIComponent(session.id)}`, 'DELETE');
  session = undefined;
  latestSource = '';
  post({ type: 'session', id: null });
  post({ type: 'snapshot', screenshot: null, source: '' });
  post({ type: 'notice', level: 'success', text: 'セッションを終了しました。' });
}

async function command<T>(path: string, method: string, body?: unknown): Promise<T> {
  const current = ensureSession();
  const response = await request<AppiumResponse<T>>(
    `${current.serverUrl}/session/${encodeURIComponent(current.id)}${path}`,
    method,
    body
  );
  return response.value as T;
}

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  output.appendLine(`${method} ${url}`);
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { value: raw }; }
  if (!response.ok) {
    const value = (parsed as { value?: { message?: string } | string }).value;
    const detail = typeof value === 'object' && value !== null ? value.message : value;
    throw new Error(`Appium request failed (${response.status}): ${detail ?? raw}`);
  }
  return parsed as T;
}

function ensureSession(): SessionState {
  if (!session) {
    throw new Error('先に Appium セッションを開始してください。');
  }
  return session;
}

function normaliseServerUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Appium Server URL は http:// または https:// で始めてください。');
  }
  return url;
}

function post(message: unknown): void {
  void panel?.webview.postMessage(message);
}

function postServerState(): void {
  post({ type: 'server', running: Boolean(serverProcess) });
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));
  const nonce = crypto.randomUUID();
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
  <link href="${style}" rel="stylesheet">
  <title>Appium Inspector Lite</title>
</head>
<body>
  <main>
    <header><h1>Appium Inspector Lite</h1><span id="session-state">未接続</span></header>
    <section class="card" id="connection-card">
      <h2>接続</h2>
      <label>Appium Server URL<input id="server-url" value="http://127.0.0.1:4723" spellcheck="false"></label>
      <div class="actions"><button id="start-server" class="secondary">Server 起動</button><button id="stop-server" class="secondary" disabled>Server 停止</button><button id="show-log" class="secondary">ログを表示</button><span id="server-state">停止中</span></div>
      <label>Capabilities (JSON)<textarea id="capabilities" spellcheck="false">{
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:deviceName": "Android Emulator"
}</textarea></label>
      <div class="actions"><button id="start">セッション開始</button><button id="quit" class="secondary">セッション終了</button></div>
    </section>
    <section class="card">
      <div class="section-heading"><h2>画面</h2><button id="refresh" class="secondary">更新</button></div>
      <div id="screenshot-empty">セッションを開始すると、端末画面がここに表示されます。</div>
      <img id="screenshot" alt="Appium screenshot">
      <p id="screenshot-hint">スクリーンショット上の要素をクリックすると、対応するネイティブ要素を選択します。</p>
    </section>
    <section class="card">
      <h2>要素を検索</h2>
      <div class="find-row"><select id="using"><option value="accessibility id">accessibility id</option><option value="id">id</option><option value="xpath">xpath</option><option value="class name">class name</option><option value="-android uiautomator">Android UIAutomator</option><option value="-ios predicate string">iOS predicate</option></select><input id="locator" placeholder="例: login_button"><button id="find">検索</button></div>
      <div id="element-result" hidden>
        <code id="element-id"></code>
        <div class="actions"><button id="copy-locator" class="secondary">locator をコピー</button><button id="tap">タップ</button></div>
        <label>テキスト入力<input id="text-to-send" placeholder="入力する文字列"></label>
        <button id="send-keys">入力</button>
      </div>
    </section>
    <section class="card"><div class="section-heading"><h2>Page Source</h2><button id="copy-source" class="secondary">XMLをコピー</button></div><pre id="source">まだ取得していません。</pre></section>
    <p id="notice" role="status"></p>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

export function deactivate(): void {
  void quitSession().catch(() => undefined);
  serverProcess?.kill('SIGTERM');
}
