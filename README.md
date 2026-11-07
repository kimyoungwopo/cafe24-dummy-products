# cafe24-dummy-products

> A zero-dependency Node.js CLI that seeds a Cafe24 shop with realistic dummy products, main-page displays and product reviews for skin/theme testing — and cleans them up again.

카페24 쇼핑몰에 **스킨·디자인 테스트용 더미 데이터**(상품, 메인진열, 상품후기)를 한 번에 채우고, 다 쓰면 한 번에 지우는 CLI입니다.
카페24 공식 Admin API(OAuth 2.0)를 사용하며, 외부 패키지 없이 Node.js 18.3 이상에서 바로 동작합니다.

> 카페24와 무관한 개인 프로젝트입니다. 손님이 들어오는 운영 쇼핑몰보다는 테스트용 쇼핑몰에서 쓰는 것을 권합니다.

- 그럴듯한 한국어 상품명·가격·소비자가(할인 표시용)·상세설명 자동 생성
- 번호가 찍힌 색상별 상품 이미지 자동 생성·업로드 (목록/상세/축소 이미지 자동 리사이징)
- 여러 상품분류에 고르게 나눠 등록 (`--spread` 또는 `-c 29,30,32`). 분류 이름에 맞는 상품명(Jackets → 자켓, Skirts → 스커트 …)과 옵션(의류는 S~XL, 신발은 230~270, 잡화는 색상만)을 자동으로 골라요
- 하위 분류에 넣을 때 상위 분류(예: Tops > Tees)에도 함께 등록해 상위 목록에서도 보여요
- 더미 상품은 자체상품코드 `DUMMY-<15자리 배치ID>-<3자리 번호>`로 표시되어, **list·delete는 정확히 이 형식인 상품에만** 적용됩니다 (직접 만든 `DUMMY-SHIRT` 같은 코드는 건드리지 않음)
- 카페24 호출 제한(초당 2회, 버킷 40) 준수, 429 오류 시 자동 재시도, 토큰 자동 갱신
- 상품 등록(POST)은 서버 오류·네트워크 오류 때 **재시도하지 않습니다** (응답만 잃고 실제로는 등록됐을 수 있어 중복 등록을 막기 위함). 조회·삭제는 최대 3회 재시도합니다

## 1. 카페24 개발자센터에서 앱 준비 (최초 1회)

1. [카페24 개발자센터](https://developers.cafe24.com)에서 앱을 만듭니다.
2. 앱 설정에서 다음을 확인·설정합니다.
   - **Client ID / Client Secret**
   - **Redirect URI**: 본인이 관리하는 도메인의 https 주소 하나 (예: `https://내도메인/cafe24/callback`). 그 경로에 실제 페이지가 없어도 됩니다. 승인 후 주소창의 URL만 복사하면 됩니다
   - **권한(Scope)**: 상품 읽기·쓰기(`mall.read_product`, `mall.write_product`), 상품분류 읽기(`mall.read_category`), 상품후기를 쓰려면 게시판 읽기·쓰기(`mall.read_community`, `mall.write_community`)
3. 테스트할 쇼핑몰에 앱을 설치(테스트 실행)할 수 있는 상태인지 확인합니다.

## 2. 설정

```bash
cd cafe24-dummy-products
cp .env.example .env
```

`.env`를 열어 `CAFE24_MALL_ID`, `CAFE24_CLIENT_ID`, `CAFE24_CLIENT_SECRET`, `CAFE24_REDIRECT_URI`를 채웁니다.

## 3. 로그인

```bash
node src/cli.js login
```

브라우저가 열리면 쇼핑몰 관리자로 로그인하고 권한을 승인합니다. Redirect URI로 이동하면(페이지가 안 열려도 괜찮습니다) **주소창의 URL 전체**를 복사해 터미널에 붙여넣습니다. 인증 코드는 1분 동안만 유효합니다.

토큰은 `.cafe24-token.json`에 저장됩니다. Access Token(2시간)은 자동으로 갱신되고, Refresh Token(2주)이 만료되면 `login`을 다시 하면 됩니다.

## 4. 사용

```bash
# 카테고리 번호 확인
node src/cli.js categories

# 더미 상품 20개를 24번 분류에 등록
node src/cli.js create -n 20 -c 24

# 옵션(색상·사이즈) 있는 상품으로 등록
node src/cli.js create -n 10 -c 24 --options

# 진열 중인 모든 맨 아래 분류에 고르게 나눠 60개 등록
node src/cli.js create -n 60 --spread --options

# 원하는 분류 몇 곳에만 번갈아 등록
node src/cli.js create -n 20 -c 29,30,34,35 --options

# 실제 등록 전에 어떤 분류·상품명으로 들어갈지 미리 보기 (로그인돼 있으면 실제 분류 이름 사용)
node src/cli.js create -n 24 --spread --dry-run

# 실제 등록 없이 보낼 내용만 확인
node src/cli.js create -n 3 --dry-run

# 등록된 더미 상품 보기 / 특정 배치만 보기
node src/cli.js list
node src/cli.js list --run 261107153012345

# 특정 배치만 삭제 / 모든 더미 상품 삭제
node src/cli.js delete --run 261107153012345
node src/cli.js delete
```

### 메인진열 채우기

메인 화면의 추천상품·신상품 같은 메인분류에 더미 상품을 올립니다. 메인분류마다 서로 다른 더미 상품이 들어가요.

```bash
node src/cli.js mains                 # 메인분류 목록과 상품 수
node src/cli.js fill-mains -n 8       # 모든 메인분류에 8개씩
node src/cli.js fill-mains -n 12 --group 2,3   # 특정 메인분류만
node src/cli.js clear-mains           # 메인진열에서 더미 상품만 빼기 (상품은 그대로)
```

메인분류 상품 조회 API에는 캐시가 있어서 `mains`의 숫자가 잠시 틀릴 수 있어요. 실제 반영은 쇼핑몰 메인 화면에서 확인하세요.

### 상품후기 달기

더미 상품마다 후기를 1~n개씩 답니다(상품마다 개수가 달라요). 별점은 1~5점이 섞이고, 작성일은 최근 두 달 안에 흩어지며, 3개 중 1개는 상품 이미지를 첨부한 포토후기예요.
게시판 권한(`mall.read_community`, `mall.write_community`)이 필요하므로 개발자센터 앱 권한에 **게시판(Community) 읽기+쓰기**를 켜고 `login`을 다시 하세요.

```bash
node src/cli.js boards                # 게시판 목록
node src/cli.js reviews -n 3          # 이름에 "후기"/"review"가 들어간 게시판에 상품당 1~3개
node src/cli.js reviews --board 4     # 게시판 번호를 직접 지정
node src/cli.js clear-reviews         # 더미 후기만 삭제
```

더미 후기는 제목이 `[더미] `로 시작하고 정해진 더미 작성자 이름으로 등록되며, `clear-reviews`는 이 두 조건을 모두 만족하는 글만 지웁니다. **상품을 지워도 후기는 남으므로** 정리할 때는 `clear-reviews` → `delete` 순서로 하세요.

### create 옵션

| 옵션 | 설명 |
| --- | --- |
| `-n, --count <수>` | 등록 개수 (기본 10, 최대 500) |
| `-c, --category <번호>` | 진열할 상품분류 번호. 쉼표로 여러 개 지정하면 번갈아 배정 (`-c 29,30,32`) |
| `--spread` | 진열 중(use_display)인 맨 아래 분류 전체에 고르게 나눠 등록 |
| `--options` | 색상 3종 × 사이즈 4종 옵션 추가 |
| `--hidden` | 진열안함·판매안함 상태로 등록 |
| `--no-image` | 이미지 업로드 생략 (더 빠름) |
| `--prefix <문자열>` | 상품명 앞 문구 (기본 `[더미] `) |
| `--dry-run` | API 호출 없이 요청 내용만 출력 |

등록 결과(상품번호, 실패 내역)는 `logs/run-<배치ID>.json`에 남습니다.

## 주의

- 기본값은 **진열함·판매함**입니다. 스킨 화면에 상품이 보여야 하기 때문입니다. 손님이 들어오는 운영 쇼핑몰이라면 `--hidden`을 쓰거나 테스트 쇼핑몰에서 사용하세요.
- 카페24에서 삭제한 상품은 복구할 수 없습니다. `delete`는 자체상품코드가 `DUMMY-<15자리>-<3자리>` 형식인 상품만 지우고, 지우기 전에 대상 개수와 앞의 5개를 보여 준 뒤 확인을 받습니다(`--yes`로 생략 가능). `--run`에 빈 값이나 잘못된 값을 주면 아무것도 지우지 않고 오류로 끝납니다.
- 호출 제한 때문에 상품 1개당 약 1초(이미지 포함)가 걸립니다. 100개면 2분 정도입니다.
- 상품 목록 API에는 캐시가 적용되어, 방금 등록한 상품이 `list`에 바로 안 보일 수 있습니다. `--run`을 주면 `logs/run-<배치ID>.json`에 기록된 상품번호로 보완하므로, 등록 직후에도 그 배치는 빠짐없이 지울 수 있습니다.
- 로그인이 풀리거나 토큰 갱신이 실패하면 `create`·`delete`는 바로 멈춥니다.

## 테스트

카페24에 실제로 접속하지 않고, 카페24 API를 흉내 내는 목 서버로 등록·조회·삭제·토큰 갱신·429 재시도를 검증합니다.

```bash
npm test
```

## 구조

```
src/
  cli.js      명령 진입점 (login, status, categories, create, list, delete)
  auth.js     OAuth 로그인, 토큰 저장·자동 갱신
  api.js      Admin API 클라이언트 (호출 제한, 재시도)
  dummy.js    더미 상품 데이터 생성
  image.js    더미 PNG 이미지 생성 (의존성 없음)
  config.js   .env 로드, 경로·상수
test/
  mock-server.js  카페24 API 목 서버
  cli.test.js     테스트
```
