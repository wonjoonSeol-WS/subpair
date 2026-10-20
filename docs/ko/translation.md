---
title: 번역
nav: 번역
order: 2
ref: translation
lang: ko
language: 한국어
lang_order: 2
---

# 자막 번역하기

모국어 자막이 없는 작품도 괜찮아요. Subpair가 원어 자막을 번역해서 두 번째 줄에 보여 줘요. 번역은 내 PC에서 도는 작은
프로그램인 **번역 도우미**가 맡고, 한 번 번역한 작품은 저장해 두기 때문에 다음에는 바로 떠요. Jellyfin에서는 한 화의
번역이 끝나면 다음 화도 미리 번역해 둬요.

## 어떤 번역기를 쓸까요?

| 번역기 | 이런 분께 | 비용 |
|---|---|---|
| **ezTrans** | 일본어 작품을 한국어로 보는 Windows 사용자 (ezTrans XP 필요) | 무료, 인터넷 없이 |
| **Claude** | Claude를 구독 중인 분. 어떤 언어든 번역해요 | 구독에 포함 |
| **AI API** | Anthropic, OpenAI, Gemini 등의 API 키가 있는 분 | 한 화에 약 10원 |
| **로컬 AI** | Ollama나 LM Studio를 쓰는 분 | 무료 |

따로 고르지 않아도 돼요. 기본값인 **자동**이 쓸 수 있는 번역기를 골라 주고, 일본어에서 한국어라면 ezTrans를 먼저 써요.

## ezTrans로 바로 시작하기 (Windows)

1. **ezTrans XP 설치하기**: 이미 설치되어 있다면 넘어가세요. 설치 폴더는 번역 도우미가 알아서 찾아요.
2. **Node.js 설치하기**: [nodejs.org](https://nodejs.org/ko)에서 **LTS** 버전을 받아 기본 설정 그대로 설치해요.
3. **Subpair 받기**: [ZIP 파일 받기](https://github.com/wonjoonSeol-WS/subpair/archive/refs/heads/main.zip)를 눌러
   받은 다음, 문서 폴더처럼 원하는 곳에 압축을 풀어요.
4. **번역 도우미 켜기**: 압축을 푼 폴더에서 `start-bridge.cmd`를 더블클릭해요. 검은 창에 `ezTrans XP in ...`이
   보이면 준비 끝이에요. 영상을 보는 동안에는 이 창을 열어 두세요.
5. **작품 틀기**: 일본어 자막만 있는 작품을 틀면 두 번째 줄에 한국어 번역이 나와요.

인터넷에서 받은 파일이라 Windows가 보안 경고를 띄울 수 있어요. 그럴 땐 **실행**을 누르세요. 파란 창이 뜨면 **추가
정보**를 누른 다음 **실행**을 누르면 돼요.

### PC를 켤 때 자동으로 켜기

압축을 푼 폴더의 `scripts\windows`에서 `autostart-on.cmd`를 더블클릭하세요. 그러면 Windows에 로그인할 때마다 번역
도우미가 창 없이 켜지고, `start-bridge.cmd`는 더 이상 실행하지 않아도 돼요. 다시 끄려면 같은 폴더의
`autostart-off.cmd`를 더블클릭하세요.

### 잘 안 될 때

- **검은 창에 `ezTrans XP not found`가 나와요**: ezTrans XP를 기본 위치에 설치했는지 확인하세요. 다른 곳에 설치했다면
  [README의 설정 방법](https://github.com/wonjoonSeol-WS/subpair/blob/main/README.ko.md#번역-도우미-설정)으로 폴더를
  지정할 수 있어요.
- **`Node.js is not installed`가 나와요**: 2단계의 Node.js를 설치한 뒤 다시 더블클릭하세요.
- **번역이 나오지 않아요**: 번역 도우미 창이 열려 있는지 확인하세요. 창을 닫으면 번역도 멈춰요.

## 다른 번역기 쓰기

번역 도우미를 켜는 방법(위 2~4단계)은 똑같아요. 번역기만 준비한 다음, 영상의 톱니바퀴 메뉴에서 **번역기**를 고르세요.

- **Claude**: [Claude Code](https://claude.com/claude-code)를 설치하고, 한 번 실행해서 로그인해 두면 끝이에요.
- **AI API, 로컬 AI**: API 키나 주소를 설정 파일에 적어야 해요.
  [README의 번역 도우미 설정](https://github.com/wonjoonSeol-WS/subpair/blob/main/README.ko.md#번역-도우미-설정)을
  참고하세요.

macOS와 Linux에서도 번역 도우미를 쓸 수 있어요(ezTrans는 Windows 전용). 실행 방법은 README에 있어요.

## 비용

AI API로 애니메이션 한 화(약 300줄)를 번역하면 **약 10원**, 12화짜리 시즌 하나는 **약 100~160원**이에요. 기본 모델인
Claude Haiku 5.5 요금으로 계산한 추정치예요(2026년 10월, 1달러 약 1,330원 기준). 한 번 번역한 줄은 다시 돈이 들지
않아요. ezTrans와 로컬 AI는 무료이고, Claude는 구독 사용량에 포함돼요.

## 톱니바퀴 메뉴에서 할 수 있는 것

- **번역기**: 쓸 번역기와 번역 시점(자동, 실시간으로 몇 줄 앞서, 지금 작품 전체)을 골라요.
- **이 작품 다시 번역**: 번역이 마음에 들지 않으면 새로 번역해요(두 번 클릭).
- **시즌 전체 번역** (Jellyfin): 한 화씩 차례로 미리 번역해 둬요.
- **대신 주 자막을 번역**: 작품에 들어 있는 모국어 자막이 이상하거나 싱크가 맞지 않을 때, 그 자막 대신 번역을 써요.
  작품마다 기억해요.
- **영상에 주 자막 표시**: 끄면 번역된 자막만 보여요. 외국어 공부 없이 내 언어로만 보고 싶은 친구들에게 좋아요.

Jellyfin에서는 번역이 끝나면 그 화에 자막으로도 저장돼서, TV나 휴대폰의 Jellyfin 앱에서도 보여요. 그 언어 자막이 없는
화에만 저장하고, Jellyfin 계정에 자막 관리 권한이 있어야 해요.
