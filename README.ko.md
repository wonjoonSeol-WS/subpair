# Subpair

[English](README.md) | 한국어 | [日本語](README.ja.md)

Subpair는 **Netflix**와 **Jellyfin**에서 **자막 두 줄을 함께** 보여 주는 브라우저 확장 프로그램입니다. 한 줄은 배우고
있는 언어, 다른 한 줄은 내 언어입니다. 대본 패널, 한 줄 다시 듣기, 자동 일시정지, 단어 클릭 복사 기능으로
Language Reactor처럼 영상을 보면서 공부할 수 있습니다. 작품에 내 언어 자막이 없으면 컴퓨터에서 실행하는
프로그램(선택 사항)이 주 자막을 번역합니다.

![Jellyfin 영상 위의 일본어 줄과 한국어 줄, 그리고 대본 패널](docs/images/jellyfin-player.png)

## 기능

- 두 줄을 함께 표시하며, 줄마다 대체 언어를 지정할 수 있습니다. 텍스트를 그대로 선택할 수 있어 Yomitan 같은 사전
  확장 프로그램으로 찾아볼 수 있습니다.
- 이전 줄 / 현재 줄 반복 / 다음 줄, 줄이 끝날 때마다 자동 일시정지, 클릭할 수 있는 대본 패널.
- 일본어 단어를 품사별로 색을 입혀 표시합니다. 단어를 클릭하면 그 단어나 기본형을 복사합니다.
- 로컬 **브리지**를 통한 번역(선택 사항): ezTrans, Claude Code, Anthropic API 또는 OpenAI 호환 API라면
  무엇이든(OpenAI, Gemini, DeepSeek, Ollama 등). 끝난 번역은 저장되므로 같은 번역에 비용을 두 번 내지 않습니다.
- 인터페이스는 영어, 한국어, 일본어를 지원하며 브라우저 언어를 따릅니다.

## 설치

1. 이 저장소를 내려받거나 클론합니다.
2. Chrome 또는 Edge: `chrome://extensions`(Edge는 `edge://extensions`)를 열고 개발자 모드를 켠 다음,
   **압축해제된 확장 프로그램을 로드합니다**를 클릭해 이 폴더를 선택합니다.
   Firefox: `npm run build:firefox`를 실행하고 `about:debugging`에서 `dist/firefox/manifest.json`을 불러옵니다.
3. 열리는 설정 페이지에서 언어를 고른 다음, Netflix나 Jellyfin에서 아무 영상이나 재생합니다.

번역은 선택 사항입니다. [Node.js](https://nodejs.org/) 21 이상을 설치하고 `bridge/config.example.json`을
`bridge/config.json`으로 복사한 다음 `npm run bridge`를 실행합니다.

**단계별 전체 안내는 [문서](docs/ko/index.md)에 있습니다**(프로젝트 웹사이트로도 공개되어 있습니다). Netflix와
Jellyfin 설정, 번역기, 모델과 비용, 컴퓨터를 켤 때 브리지 시작하기, 문제 해결을 다룹니다.

## 지원 플랫폼

| | Windows | macOS | Linux |
|---|---|---|---|
| 확장 프로그램(Chrome 111+, Edge, Brave, Firefox 128+) | 지원 | 지원 | 지원 |
| Claude, Anthropic API 또는 OpenAI 호환 API를 쓰는 브리지 | 지원 | 지원 | 지원 |
| ezTrans 번역기 | 지원 | 미지원 | 미지원 |

작성자는 Windows에서만 테스트했습니다. 서명된 버전이 공개될 때까지 Firefox에는 임시로만 설치됩니다.

## 개인정보 보호

Subpair는 보고 있는 페이지에서 자막을 읽습니다. 번역을 켜지 않는 한 어떤 데이터도 컴퓨터 밖으로 나가지 않습니다.
번역을 켜면 자막 줄이 `127.0.0.1`의 브리지로 가고, 거기서 선택한 번역기로 전달됩니다. Subpair는 Jellyfin 서버에서
동작하기 전에 먼저 허락을 구합니다.

## 기여하기

[CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

## 라이선스

MIT. `vendor/kuromoji`는 Apache-2.0입니다. Subpair는 Netflix, Jellyfin과 제휴 관계가 없습니다.
