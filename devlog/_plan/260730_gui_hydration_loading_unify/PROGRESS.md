# 구현 진행 기록

유닛 `260730_gui_hydration_loading_unify`. 이슈 #753.
각 WP는 완전한 PABCD 사이클 하나이며, 종료 시 로컬 커밋 하나를 남긴다.

## 사용자 정정 (2026-07-30)

최초 리서치는 탭 전환 시 82ms 빈 창에 초점을 맞췄다. 사용자가 정정했다.

> "지금 불러와지는건 정상이고 그 전역설치본도 지금 그게 너무느리게 로딩된다고
> 그래서 스피너를 도입하자는거고"

즉 기능 결함이 아니라 **느린 대기 구간이 보이지 않는 것**이 문제다. 실측
`?refresh=1` 908ms, 서버 콜드 경로 `8s × ceil(계정수/4)`. 이 정정이 WP2의 범위를
바꿨다 — 어댑터·프리미티브만으로는 계정 목록에 아무 변화가 없기 때문에
`useCodexAccountPool`까지 WP2에 포함됐다.

## WP2 — 로딩 계약 기반 (완료)

커밋 `ba3a29d32`. A 감사 5라운드(FAIL 4회 → PASS).

감사가 잡아낸 설계 결함과 반영:

| # | 결함 | 반영 |
|---|------|------|
| 1 | 어댑터만 추가하면 계정 목록에 변화 없음 (다른 훅이 소유) | `useCodexAccountPool`을 WP2 범위에 포함 |
| 2 | `loading-with-stale-data`가 죽은 코드 — 스토어가 데이터 있으면 `loading`을 안 올림 | 스토어에 `refreshing` 추가 |
| 3 | `enabled: false`가 영구 스켈레톤 | `disabled` 상태 추가 |
| 4 | `throw undefined` 판별 불가 | 스토어 경계에서 정규화 |
| 5 | `attemptsRef`를 렌더에서 읽음 | 메커니즘 폐기, `hasSucceeded`/`lastAttemptOk`를 스냅샷으로 |
| 6 | 라이브 리전 이중 알림 | `live` prop + 오류 배너 소유권 규칙 |
| 7 | 콜드 재시도가 정지 화면 | `retrying-cold` 추가, 인플라이트를 실패보다 우선 평가 |
| 8 | 계정 풀 `refreshing`이 겹친 요청에서 조기 해제 | 인플라이트 카운터 |
| 9 | `try/finally`가 `beginActiveRead()` throw 미포함 | `try`를 카운터 증가 직후로 |
| 10 | 점진 페인트 회귀 (`accountsOk && activeOk`로 바꿨던 것) | 원형 분기 보존 |

### 변경 파일

- `gui/src/client-resource.ts` — `refreshing` / `hasSucceeded` / `lastAttemptOk`.
  `loading`의 기존 의미("콘텐츠를 대체해도 됨")는 불변.
- `gui/src/data-surface.ts` (신규) — 8상태 분류 + `useDataSurface` 순수 어댑터.
- `gui/src/components/data-surface.tsx` (신규) — 스켈레톤·상태줄 프리미티브.
- `gui/src/styles.css` — 규칙 3개. `.spin`과 기존 shimmer 재사용, 신규 토큰 0개.
- `gui/src/hooks/useCodexAccountPool.ts` — 인플라이트 카운터 + `firstAttemptSettled`,
  컨트롤러에 `refreshing` / `initialLoading` 노출.
- `gui/src/components/CodexAccountPool.tsx` — 재검증 중 상태줄.
- 테스트 3파일 (신규 9건 + 추가 2건 + 계약 목록 2필드).

### 검증

```
bun run typecheck                 exit 0
(cd gui && bun run build)         tsc -b && vite build 성공
(cd gui && bun test tests)        410 pass / 0 fail / 1847 expect / 84 files
bun run lint:gui                  무경고
bun run privacy:scan              passed
```

활성화 증거 (도그푸딩 인스턴스, 포트 10199, 로컬 dev 빌드):

| 경로 | 관측 |
|------|------|
| 강제 새로고침 클릭 | 139–669ms 동안 `.data-surface-status` + `.spin` + `aria-busy=true`, 계정 행 유지, 800ms 해제 |
| 조용한 30초 폴링 (클릭 없음) | 지연 에뮬레이션(1200ms) 하에 18293ms 시점 `status=true spin=true busy=true`, 행 유지 |
| 겹친 요청 | 일반 load가 먼저 해제돼도 `refreshing` 유지, 강제 해제 후 false |
| 콜드 실패 | `initialLoading=false`, `loadState=error` — 무한 스켈레톤 없음 |

스크린샷: `.tmp/dogfood/shots/refresh-spinner.png` (추적 안 되는 스크래치 경로).

### 도그푸딩 셋업

처음에는 사용자의 상시 프록시(포트 10100)를 건드리지 않고 별도 인스턴스로 검증했다.

```bash
OPENCODEX_HOME=<repo>/.tmp/dogfood bun run src/cli/index.ts start --port 10199
```

`findGuiDist()`가 소스 위치 기준으로 dist를 찾으므로 이 인스턴스는 방금 빌드한
`gui/dist`를 서빙한다.

**이후 사용자 요청으로 전역 `ocx`를 로컬 트리 symlink로 전환했다.** 이제 포트 10100의
상시 서비스도 로컬 코드를 실행한다.

```bash
# 기존 npm 설치본을 보존
mv ~/.bun/install/global/node_modules/@bitkyc08/opencodex \
   ~/.bun/install/global/node_modules/@bitkyc08/opencodex.npm-2.7.43.bak

# 로컬 트리로 링크
ln -s /Users/jun/Developer/new/700_projects/opencodex \
      ~/.bun/install/global/node_modules/@bitkyc08/opencodex

ocx service stop && ocx service start
```

`~/.bun/bin/ocx`는 원래부터 그 패키지 경로를 가리키는 symlink이고 launchd plist도
`<pkg>/src/cli/index.ts`를 실행하므로, 패키지 디렉터리 하나만 바꾸면 CLI·서비스·GUI가
모두 로컬 소스를 쓴다. 되돌리려면 링크를 지우고 `.npm-2.7.43.bak`을 제자리로 옮긴다.

검증: `readlink -f ~/.bun/bin/ocx` → 로컬 `bin/ocx.mjs`,
`curl -s http://127.0.0.1:10100/ | rg -o 'assets/[^"]+'`가 로컬 `gui/dist` 해시와 일치,
서빙 중인 CSS에 `.data-surface-status` 규칙 존재.

## WP3 — 15표면 이관 (진행 중, 12/15)

`020_page_migration.md` 소비. 커밋 3개.

| 커밋 | 표면 |
|------|------|
| `a9903875d` | Grok (기준 구현) + `page-loading-contract.test.tsx` 신설 |
| `1b6dae373` | Subagents, Combos, Usage, Startup, Logs, Debug, Claude Code/Desktop |
| `8759e34de` | Storage, API, Models + 0ms 타이머 6곳 제거 |

계약 테스트가 12표면을 고정한다. 남은 3개는 Dashboard, Providers, Codex 인증인데,
세 곳 모두 이미 공용 리소스 계층이나 전용 컨트롤러를 쓰고 스켈레톤도 갖고 있어
어댑터로 감싸는 이득이 작다. Providers와 Codex 인증은 이번 커밋에서 0ms 타이머만
제거했다. 남은 판단은 WP3의 마지막 사이클에서 한다.

### 이번 사이클에서 드러난 것

- **0ms 타이머가 lint 규칙의 회피책이었다.** `react-hooks/set-state-in-effect`가 이펙트
  본문의 동기 setState를 막으므로 원저자가 타이머로 미뤘고, 그 타이머가 cleanup에서
  취소되면서 요청이 사라졌다. 마이크로태스크가 양쪽을 만족한다.
- **키가 바뀌는 재구독이 요청을 두 번 보냈다.** 새 키 구독의 콜드 페치와 deps 변경의
  강제 재검증이 겹쳤다. `useKeyedClientResource`에서 키가 함께 바뀐 경우를 건너뛰게 했다.
  WP4의 요청 감축에 그대로 기여한다.
- **모듈 캐시가 테스트 격리를 깬다.** 리소스 캐시가 모듈 레벨이라 앞선 케이스의 응답이
  다음 케이스의 콜드 마운트를 만족시켰다. 6개 테스트 파일에
  `clearClientResourceStoresForTests()`를 넣었다.
