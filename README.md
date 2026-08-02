# Appium Inspector Lite

VS Code 内で Appium セッションを開始し、端末画面の確認、Page Source の閲覧、要素操作を行うための MVP 拡張です。

## できること

- Appium Server への接続と W3C セッションの開始・終了
- 端末スクリーンショットと XML Page Source の取得
- スクリーンショット上のクリック位置から、対応するネイティブ要素を選択
- `accessibility id`、`id`、`xpath`、Android UIAutomator、iOS predicate による要素検索
- 検索した要素のタップ・テキスト入力・locator コピー

## 使い方

1. Appium Server と対象端末（エミュレータまたは実機）を起動します。
2. VS Code でコマンドパレットを開き、`Appium Inspector: Open` を実行します。
3. Server URL と Capabilities を入力して **セッション開始** を選びます。

ローカルに `appium` コマンドをインストール済みであれば、Inspector の **Server 起動** からも起動できます。`localhost` / `127.0.0.1` のみ対応し、サーバーログは **ログを表示** で確認できます。

標準的な Android の例:

```json
{
  "platformName": "Android",
  "appium:automationName": "UiAutomator2",
  "appium:deviceName": "Android Emulator",
  "appium:appPackage": "com.example.app",
  "appium:appActivity": ".MainActivity"
}
```

## 開発

```bash
npm install
npm run compile
```

VS Code でこのフォルダを開き、`F5` で **Appium Inspector Lite をデバッグ起動** を選ぶと、ビルド後に Extension Development Host が起動します。

Extension Development Host 上では、`⌘⌥A`（Windows / Linux: `Ctrl+Alt+A`）で Inspector を開けます。
