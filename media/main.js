const vscode = acquireVsCodeApi();
const state = { element: null, session: null, source: '' };

const $ = (selector) => document.querySelector(selector);
const send = (message) => vscode.postMessage(message);

$('#start').addEventListener('click', () => send({
  type: 'startSession',
  serverUrl: $('#server-url').value,
  capabilities: $('#capabilities').value
}));
$('#start-server').addEventListener('click', () => send({ type: 'startServer', serverUrl: $('#server-url').value }));
$('#stop-server').addEventListener('click', () => send({ type: 'stopServer' }));
$('#show-log').addEventListener('click', () => send({ type: 'showOutput' }));
$('#quit').addEventListener('click', () => send({ type: 'quitSession' }));
$('#refresh').addEventListener('click', () => send({ type: 'refresh' }));
$('#find').addEventListener('click', () => send({ type: 'findElement', using: $('#using').value, value: $('#locator').value }));
$('#tap').addEventListener('click', () => state.element && send({ type: 'clickElement', elementId: state.element.id }));
$('#send-keys').addEventListener('click', () => state.element && send({ type: 'sendKeys', elementId: state.element.id, text: $('#text-to-send').value }));
$('#copy-locator').addEventListener('click', () => state.element && send({ type: 'copy', text: `${state.element.using}: ${state.element.value}` }));
$('#copy-source').addEventListener('click', () => state.source && send({ type: 'copy', text: state.source }));
$('#screenshot').addEventListener('click', (event) => {
  const image = event.currentTarget;
  if (!state.session || !image.naturalWidth || !image.naturalHeight) return;
  const rect = image.getBoundingClientRect();
  const x = (event.clientX - rect.left) * image.naturalWidth / rect.width;
  const y = (event.clientY - rect.top) * image.naturalHeight / rect.height;
  send({ type: 'selectScreenshotElement', x, y, screenshotWidth: image.naturalWidth, screenshotHeight: image.naturalHeight });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'session') {
    state.session = message.id;
    $('#session-state').textContent = message.id ? `接続中: ${message.id}` : '未接続';
  }
  if (message.type === 'server') {
    $('#server-state').textContent = message.running ? 'Server 起動中' : 'Server 停止中';
    $('#start-server').disabled = message.running;
    $('#stop-server').disabled = !message.running;
  }
  if (message.type === 'snapshot') {
    state.source = message.source || '';
    $('#source').textContent = state.source || 'まだ取得していません。';
    const image = $('#screenshot');
    image.src = message.screenshot ? `data:image/png;base64,${message.screenshot}` : '';
    image.hidden = !message.screenshot;
    $('#screenshot-empty').hidden = Boolean(message.screenshot);
  }
  if (message.type === 'element') {
    state.element = message;
    $('#element-id').textContent = `${message.tag ? `${message.tag} / ` : ''}element id: ${message.id}`;
    $('#element-result').hidden = false;
  }
  if (message.type === 'notice') {
    const notice = $('#notice');
    notice.textContent = message.text;
    notice.dataset.level = message.level;
  }
});
