# Subpair

[English](README.md) | [한국어](README.ko.md) | 日本語

Subpairは、**Netflix**と**Jellyfin**で**字幕を2行同時に**表示するブラウザー拡張機能です。1行は学習中の言語、もう1行は自分の言語です。トランスクリプトパネル、1行リピート、自動一時停止、クリックでの単語コピーを使って、Language Reactorのように動画を見ながら学習できます。作品に自分の言語の字幕がないときは、パソコン上で動くプログラム（任意）がメイン字幕を翻訳します。

![Jellyfinの動画に表示された日本語と韓国語の行、そしてトランスクリプトパネル](docs/images/jellyfin-player.png)

## 機能

- 2行を同時に表示し、行ごとに予備の言語を指定できます。テキストは選択できるままなので、Yomitanなどの辞書拡張機能で調べられます。
- 前の行 / この行をリピート / 次の行、各行の終わりでの自動一時停止、クリックできるトランスクリプトパネル。
- 日本語の単語を品詞ごとに色分けします。単語をクリックすると、その単語または辞書形をコピーします。
- ローカルの**ブリッジ**による翻訳（任意）：ezTrans、Claude Code、Anthropic API、またはOpenAI互換の任意のAPI（OpenAI、Gemini、DeepSeek、Ollamaなど）。完了した翻訳は保存されるので、同じ翻訳に二度料金を払うことはありません。
- インターフェースは英語、韓国語、日本語に対応し、ブラウザーの言語に合わせて切り替わります。

## インストール

1. このリポジトリをダウンロードするか、クローンします。
2. ChromeまたはEdge：`chrome://extensions`（Edgeでは`edge://extensions`）を開き、デベロッパー モードをオンにして、**パッケージ化されていない拡張機能を読み込む**をクリックし、このフォルダーを選びます。
   Firefox：`npm run build:firefox`を実行し、`about:debugging`から`dist/firefox/manifest.json`を読み込みます。
3. 開いた設定ページで言語を選び、NetflixまたはJellyfinで何か再生します。

翻訳は任意です。[Node.js](https://nodejs.org/) 21以降をインストールし、`bridge/config.example.json`を`bridge/config.json`にコピーして、`npm run bridge`を実行します。

**詳しい手順は[ドキュメント](docs/ja/index.md)にあります**（プロジェクトのWebサイトとしても公開しています）。NetflixとJellyfinの設定、翻訳エンジン、モデルと費用、パソコンと一緒にブリッジを起動する方法、トラブルシューティングを扱っています。

## 対応プラットフォーム

| | Windows | macOS | Linux |
|---|---|---|---|
| 拡張機能（Chrome 111+、Edge、Brave、Firefox 128+） | 対応 | 対応 | 対応 |
| Claude、Anthropic API、またはOpenAI互換APIを使うブリッジ | 対応 | 対応 | 対応 |
| ezTrans翻訳エンジン | 対応 | 非対応 | 非対応 |

作者がテストしているのはWindowsだけです。署名済みのバージョンが公開されるまで、Firefoxへのインストールは一時的なものになります。

## プライバシー

Subpairは視聴中のページから字幕を読み取ります。翻訳をオンにしない限り、データがパソコンの外に出ることはありません。翻訳をオンにすると、字幕の行は`127.0.0.1`のブリッジに送られ、そこから選んだ翻訳エンジンに送られます。SubpairはJellyfinサーバーで動作する前に確認を求めます。

## コントリビュート

[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

## ライセンス

MIT。`vendor/kuromoji`はApache-2.0です。SubpairはNetflixおよびJellyfinとは提携していません。
