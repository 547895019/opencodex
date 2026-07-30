# 030 — WP4 재검증·폴링·요청 중복 제거

작성 2026-07-30. 이 문서는 구현 diff다. 기준은 [000_plan.md:115-165](/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260730_gui_hydration_loading_unify/000_plan.md:115), [000_research.md:381-394](/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260730_gui_hydration_loading_unify/000_research.md:381), [001_live_evidence.md:47-75](/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260730_gui_hydration_loading_unify/001_live_evidence.md:47)다. E3는 npm 전역 v2.7.43 서빙본의 4초 관측이고, 아래 호출 지점은 `dev` HEAD에서 다시 확인했다.

## 현재 요청 지도

E3의 순서를 유지해 38개를 모두 적는다. `#13`·`#14`는 현재 `dev`에 두 번째 controller가 없다는 점도 같이 기록한다. `Providers.tsx`는 [92](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:92)에서 controller를 한 번 만들고, 주입받은 `CodexAccountPool`의 자체 controller는 `enabled=false`라 요청하지 않는다([CodexAccountPool.tsx:54-57](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/CodexAccountPool.tsx:54)). 따라서 E3의 두 번째 쌍은 서빙본의 같은 호출 지점 중복이지 현재 트리에 남은 별도 호출 지점이 아니다.

| E3 # | 실제 URL | 검증한 발생 파일:줄 | 설명 |
|---:|---|---|---|
| 1 | `/api/codex-auth/accounts` | [useCodexAccountPool.ts:148](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:148) | Providers가 소유한 pool의 첫 목록 read |
| 2 | `/api/codex-auth/active` | [useCodexAccountPool.ts:167](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:167) | 같은 `load()`의 active read |
| 3 | `/api/config` | [use-providers-fetch.ts:29](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-providers-fetch.ts:29) | Providers config |
| 4 | `/api/oauth/providers` | [use-providers-fetch.ts:41](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-providers-fetch.ts:41) | OAuth provider 목록 |
| 5 | `/api/provider-quotas` | [ProviderWorkspaceShell.tsx:213](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:213) | 셸 최초 quota effect |
| 6 | `/api/oauth/status?provider=xai` | [use-providers-fetch.ts:46](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-providers-fetch.ts:46) | `provs.map()` 1/7 |
| 7 | `…provider=anthropic` | 같은 46 | 2/7 |
| 8 | `…provider=kimi` | 같은 46 | 3/7 |
| 9 | `…provider=kiro` | 같은 46 | 4/7 |
| 10 | `…provider=google-antigravity` | 같은 46 | 5/7 |
| 11 | `…provider=cursor` | 같은 46 | 6/7 |
| 12 | `…provider=github-copilot` | 같은 46 | 7/7 |
| 13 | `/api/codex-auth/accounts` | [useCodexAccountPool.ts:148](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:148) | v2.7.43의 중복 pool owner; `dev`에서는 제거됨 |
| 14 | `/api/codex-auth/active` | [useCodexAccountPool.ts:167](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:167) | 위와 같은 서빙본 중복 |
| 15 | `/api/usage?range=30d` | [ProviderWorkspaceShell.tsx:171](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:171) | workspace 사용량 |
| 16 | `/api/provider-quotas` | [ProviderWorkspaceShell.tsx:213](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:213) | `quotaRefreshKey` 중간 변경 |
| 17 | `/api/selected-models` | [ProviderWorkspaceShell.tsx:142](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:142) | workspace 모델 수 |
| 18 | `/api/oauth/accounts?provider=anthropic` | [useProviderAccountPools.ts:85](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:85) | OAuth pool base 1/6 |
| 19 | `…provider=cursor` | 같은 85 | 2/6 |
| 20 | `…provider=google-antigravity` | 같은 85 | 3/6 |
| 21 | `…provider=kimi` | 같은 85 | 4/6 |
| 22 | `…provider=xai` | 같은 85 | 5/6 |
| 23 | `…provider=kiro` | 같은 85 | 6/6 |
| 24 | `/api/providers/keys?name=alibaba-token-plan-intl` | [useProviderAccountPools.ts:123](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:123) | key pool 1/3 |
| 25 | `…name=opencode-go` | 같은 123 | 2/3 |
| 26 | `…name=zenmux` | 같은 123 | 3/3 |
| 27 | `/api/oauth/accounts?provider=anthropic&quota=1` | [useProviderAccountPools.ts:96](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:96) | base read 뒤 quota 재read 1/6 |
| 28 | `…provider=cursor&quota=1` | 같은 96 | 2/6 |
| 29 | `/api/provider-quotas` | [ProviderWorkspaceShell.tsx:213](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:213) | 응답 도착 뒤 effect 재실행 |
| 30 | `/api/provider-quotas` | 같은 213 | 응답 도착 뒤 effect 재실행 |
| 31 | `…provider=google-antigravity&quota=1` | [useProviderAccountPools.ts:96](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:96) | 3/6 |
| 32 | `/api/provider-quotas` | [ProviderWorkspaceShell.tsx:213](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:213) | 응답 도착 뒤 effect 재실행 |
| 33 | `…provider=kimi&quota=1` | [useProviderAccountPools.ts:96](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:96) | 4/6 |
| 34 | `/api/provider-quotas` | 같은 213 | 응답 도착 뒤 effect 재실행 |
| 35 | `…provider=xai&quota=1` | [useProviderAccountPools.ts:96](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:96) | 5/6 |
| 36 | `/api/provider-quotas` | 같은 213 | 응답 도착 뒤 effect 재실행 |
| 37 | `…provider=kiro&quota=1` | [useProviderAccountPools.ts:96](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:96) | 6/6 |
| 38 | `/api/provider-quotas` | [ProviderWorkspaceShell.tsx:213](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:213) | 마지막 quota account 응답 뒤 effect 재실행 |

`/api/usage`에는 Add Provider warm-up도 있다([Providers.tsx:72-82](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:72)). E3의 timing은 셸 effect와 맞고 이를 #15로 귀속한다. 다음 CDP 재측정에서는 Initiator를 함께 저장해 이 귀속을 URL 순서만으로 다시 추정하지 않는다.

콜드 산술은 그대로 성립한다. E3에 quota가 정확히 8개, `&quota=1`가 정확히 6개이므로 `38 - (8 - 1) - 6 = 25`다. 현재 source 읽기에서 이 수를 바꿀 근거는 없었다. `/oauth/status` 7개, key pool 3개, usage, selected-models, 서빙본의 Codex 중복은 이번 감축 대상이 아니다.

## 중복의 구조와 같은 커밋의 무효화

현재 파생식은 다음과 같다.

```ts
// /Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:129-135
const quotaRefreshKey = useMemo(
  () => Object.entries(accountSets)
    .map(([provider, set]) => `${provider}:${set.activeAccountId ?? ""}`)
    .sort()
    .join("|"),
  [accountSets],
);
```

그 값이 [Providers.tsx:273](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:273)를 거쳐 셸로 가고, 셸 effect가 [ProviderWorkspaceShell.tsx:240-242](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:240)에 의존성으로 둔다. 각 provider의 base/quota account 응답이 `accountSets` object를 새로 만들기 때문에 initial effect 뒤에 다시 돈다.

아래 diff는 파생 identity를 없애고 mutation만 증가시키는 `quotaRefresh` revision으로 바꾼다. **`switchAccount`의 `fetchProviderQuotas(true)` 호출을 유지하되, 그 함수가 이제 이 revision을 증가시키도록 같은 커밋에 바꾼다.** 이 호출을 빼거나 두 커밋으로 나누면 healthy-account switch가 quota 재검증을 잃는다.

```diff
diff --git a/gui/src/pages/Providers.tsx b/gui/src/pages/Providers.tsx
@@
-import { useEffect, useMemo, useRef, useState } from "react";
+import { useCallback, useEffect, useMemo, useRef, useState } from "react";
@@
-  const [, setQuotaReports] = useState<Record<string, import("./providers-shared").ProviderQuotaReport>>({});
+  const [quotaRefresh, setQuotaRefresh] = useState({ epoch: 0, force: false });
+  const invalidateProviderQuotas = useCallback((force = false) => {
+    setQuotaRefresh(previous => ({ epoch: previous.epoch + 1, force }));
+  }, []);
@@
-  const { fetchConfig, fetchOauth, fetchProviderQuotas } = useProvidersFetch({
-    apiBase, t, setConfig, setOauthProviders, setOauthStatus, setQuotaReports, notify,
+  const { fetchConfig, fetchOauth, fetchProviderQuotas } = useProvidersFetch({
+    apiBase, t, setConfig, setOauthProviders, setOauthStatus, notify,
+    invalidateProviderQuotas,
     configCacheKey,
   });
@@
-  const quotaRefreshKey = useMemo(
-    () => Object.entries(accountSets)
-      .map(([provider, set]) => `${provider}:${set.activeAccountId ?? ""}`)
-      .sort()
-      .join("|"),
-    [accountSets],
-  );
@@
-        quotaRefreshKey={quotaRefreshKey}
+        quotaRefreshEpoch={quotaRefresh.epoch}
+        quotaForceRefresh={quotaRefresh.force}
```

```diff
diff --git a/gui/src/pages/use-providers-fetch.ts b/gui/src/pages/use-providers-fetch.ts
@@
-  setQuotaReports,
   notify,
+  invalidateProviderQuotas,
@@
-  setQuotaReports: React.Dispatch<React.SetStateAction<Record<string, ProviderQuotaReport>>>;
   notify: (msg: string, ok: boolean) => void;
+  invalidateProviderQuotas: (force?: boolean) => void;
@@
-  const fetchProviderQuotas = useCallback(async (refresh = false) => {
-    try {
-      const res = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`);
-      const data = await readJsonIfOk<{ reports?: ProviderQuotaReport[] }>(res);
-      if (!data) return;
-      setQuotaReports(prev => {
-        const next = { ...prev };
-        for (const report of data.reports ?? []) if (report?.provider) next[report.provider] = report;
-        return next;
-      });
-    } catch { /* keep last-good */ }
-  }, [apiBase, setQuotaReports]);
+  // The shell owns the shared quota resource. Existing mutation paths keep this name.
+  const fetchProviderQuotas = useCallback(async (refresh = false) => {
+    invalidateProviderQuotas(refresh);
+  }, [invalidateProviderQuotas]);
```

```diff
diff --git a/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx b/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx
@@
 import { readJsonIfOk, readJsonOrThrow } from "../../fetch-json";
+import { useKeyedClientResource } from "../../client-resource";
@@
+type ProviderQuotaResponse = {
+  reports?: Array<{ provider: string; label?: string; source?: string; updatedAt?: number; quota?: unknown }>;
+};
+
+function mergeQuotaReports(
+  previous: Record<string, ProviderQuotaReportView>, reports: ProviderQuotaResponse["reports"], cacheKey: string,
+): Record<string, ProviderQuotaReportView> {
+  const next = { ...previous };
+  for (const report of reports ?? []) {
+    if (!report?.provider) continue;
+    next[report.provider] = {
+      label: report.label, source: report.source,
+      updatedAt: typeof report.updatedAt === "number" ? report.updatedAt : Date.now(), quota: report.quota,
+    };
+  }
+  writeSessionListCache(cacheKey, next);
+  return next;
+}
@@
-  /** Stable key of active OAuth account ids — refetch overview quotas after account switch. */
-  quotaRefreshKey = "",
+  quotaRefreshEpoch = 0,
+  quotaForceRefresh = false,
@@
-  quotaRefreshKey?: string;
+  quotaRefreshEpoch?: number;
+  quotaForceRefresh?: boolean;
@@
-  useEffect(() => {
-    let cancelled = false;
-    const timeout = window.setTimeout(() => {
-      if (!readSessionListCache(quotasCacheKey)) setQuotasLoading(true);
-      void fetch(`${apiBase}/api/provider-quotas`)
  const quotaResource = useKeyedClientResource(
    `provider-quotas:${apiBase}`,
    [apiBase, quotaRefreshEpoch, quotaForceRefresh],
    async (signal): Promise<ProviderQuotaResponse> => {
      const response = await fetch(
        `${apiBase}/api/provider-quotas${quotaForceRefresh ? "?refresh=1" : ""}`,
        { signal },
      );
      return (await readJsonOrThrow<ProviderQuotaResponse>(response)) ?? { reports: [] };
    },
  );
  useEffect(() => {
    if (quotaResource.data) {
      setQuotaReports(previous => mergeQuotaReports(previous, quotaResource.data.reports, quotasCacheKey));
    }
    setQuotasLoading(quotaResource.loading && !readSessionListCache(quotasCacheKey));
  }, [quotaResource.data, quotaResource.loading, quotasCacheKey]);
```

`mergeQuotaReports`는 기존 [ProviderWorkspaceShell.tsx:217-230](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:217)의 merge와 `writeSessionListCache`를 그대로 함수로 뽑은 전체 본문이다. `readJsonOrThrow`는 같은 파일에서 이미 selected-model load에 사용한다([142-143](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:142)).

## 인플라이트 공유

새 Map이나 promise registry를 만들지 않는다. [client-resource.ts:179-183](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:179)는 첫 subscriber만 cold `runFetch()`를 시작하고, [105-112](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:105)는 poll 중 in-flight이면 반환한다. 따라서 고정 key `provider-quotas:${apiBase}`를 두 surface가 동시에 구독하면 request 하나와 동일 snapshot을 공유한다. 위 셸 diff가 이 기존 장치를 실제 quota fetch에 연결하는 전체 변경이다.

`refresh()`는 현재 `replaceInflight: true`이라 [client-resource.ts:245-251](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:245) 강제 refresh끼리 취소 경쟁을 낼 수 있다. 이 WP는 mutation revision 하나당 request 하나만 만들며, 버튼/계정 mutation은 revision을 올리는 방식으로만 들어온다. 별도 새 `refresh()` 호출을 추가하지 않는다.

## `&quota=1` 통합

base account read와 quota enrichment read는 같은 provider와 같은 응답 shape다. 현재 `fetchAccountSets()`의 [85](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:85) 뒤 IIFE [94-110](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:94)가 여섯 번의 재read를 만든다. 다음 diff는 base read가 바로 quota 포함 응답을 받게 한다. 실패 시 기존처럼 해당 provider를 `error`로 표시하고, 성공했지만 quota probe가 실패한 별도 상태는 더 이상 없다. 이것이 E3에서 정확히 −6이다.

```diff
diff --git a/gui/src/hooks/useProviderAccountPools.ts b/gui/src/hooks/useProviderAccountPools.ts
@@
-        // Cheap local read first so account switch / reauth / remove controls appear
-        // even when Anthropic's usage endpoint is slow or timing out.
-        const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
+        const res = await fetch(
+          `${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}&quota=1`,
+        );
         if (!res.ok) throw new Error(String(res.status));
         const data = await res.json() as { activeAccountId?: string | null; accounts?: OAuthAccount[] };
@@
-
-        // Enrich with per-account rate limits asynchronously (Anthropic reports usage
-        // per credential). Failures leave the already-ready account rows untouched.
-        void (async () => {
-          try {
-            const quotaRes = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}&quota=1`);
-            if (!quotaRes.ok) return;
-            const quotaData = await quotaRes.json() as { activeAccountId?: string | null; accounts?: OAuthAccount[] };
-            if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return;
-            setAccountSets(current => ({
-              ...current,
-              [provider]: { activeAccountId: quotaData.activeAccountId ?? data.activeAccountId ?? null, accounts: quotaData.accounts ?? data.accounts ?? [] },
-            }));
-          } catch { /* keep local account rows without quota enrichment */ }
-        })();
         return true;
```

## 폴링 정책

공통 passive poll은 `client-resource.ts:97-102`에서 `document.visibilityState === "hidden"`이면 tick을 건너뛰고, `visibilitychange`가 `visible`이 될 때 subscriber가 있으면 한 번 quiet `runFetch(..., { replaceInflight: false })` 하도록 바꾼다. raw interval도 같은 guard를 둔다. 명시적 사용자 액션, OAuth 완료 감시, Debug follow, restart reconnection은 visibility로 막지 않는다. 숨김 탭이 외부 OAuth를 마친 뒤 돌아오는 경로와 장애 복구를 멈추면 안 되기 때문이다.

| 위치·간격 | 결정 | 이유 |
|---|---|---|
| [client-resource.ts:97](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:97), 모든 `pollMs` | 변경: visibility gate + visible 즉시 1회 | dashboard/debug/app poll의 공통 소유자 |
| [useCodexAccountPool.ts:83,244](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:83) 30s | 변경: hidden gate | 계정 row는 재방문 시 last-good seed가 있고 수동 refresh는 별도 |
| [CodexAuth.tsx:134](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/CodexAuth.tsx:134) config 30s | 변경: hidden gate | banner 갱신은 foreground에서 충분 |
| [App.tsx:114](/Users/jun/Developer/new/700_projects/opencodex/gui/src/App.tsx:114) health 30s | 공통 gate | version badge |
| [use-dashboard-data.ts:185](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:185) startup 30s | 공통 gate | passive 상태 |
| [use-dashboard-data.ts:193,202,213,224,232](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:193) dashboard wave 5s | 공통 gate, 유지 | live dashboard지만 hidden refresh 불필요 |
| [use-dashboard-data.ts:239](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:239) usage 60s | 공통 gate, 유지 | 비용 큰 aggregate |
| [startup-health-ui.ts:91](/Users/jun/Developer/new/700_projects/opencodex/gui/src/startup-health-ui.ts:91), diagnostics 30s | 공통 gate, 유지 | config warning |
| [use-dashboard-data.ts:398](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts:398) update 1.5s | 유지 | restart 직후 reconnect, 이미 job 조건부 |
| [Models.tsx:242,258](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Models.tsx:242) v2/models 10s | 변경: hidden gate | OAuth 직후 발견은 foreground에서만 필요 |
| [Logs.tsx:391](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Logs.tsx:391) logs 2s | 변경: hidden gate | `tab === "logs"`여도 document가 숨겨질 수 있음 |
| [Debug.tsx:48,61](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx:48) settings/inbound 2s | 공통 gate | 명시적 `active`가 이미 있음 |
| [Debug.tsx:149](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Debug.tsx:149) follow 1s | 유지 | 사용자가 follow를 켠 진단 세션 |
| [ClaudeDesktop.tsx:262](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/ClaudeDesktop.tsx:262) status 5s | 변경: 실제 hidden guard 추가 | 주석은 hidden이라지만 구현은 아직 poll함 |
| [MemoryObservabilityCard.tsx:213](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/MemoryObservabilityCard.tsx:213) memory 5s | 변경: hidden gate | passive telemetry |
| [MemoryObservabilityCard.tsx:136,278](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/MemoryObservabilityCard.tsx:136) reconnect 1.5s | 유지 | restart completion을 놓치면 안 됨 |
| [use-add-codex-account-oauth.ts:170,223](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/use-add-codex-account-oauth.ts:170) OAuth status 2s | 유지 | 외부 browser OAuth 완료 감시 |
| [use-add-provider-oauth.ts:5,57](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/use-add-provider-oauth.ts:5) provider OAuth 2s sleep loop | 유지 | 위와 같은 interactive flow |

## 보존 트리거 6종과 테스트

| 트리거 | 반드시 남을 코드 경로 | 증명 |
|---|---|---|
| 계정 전환 | [useProviderAccountPools.ts:136-140](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:136)의 성공 뒤 `fetchProviderQuotas(true)` → revision | `switchAccount` 뒤 `?refresh=1` 한 번 |
| 계정 추가/삭제 | OAuth login [use-providers-oauth.ts:131-136](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-providers-oauth.ts:131), logout [166-171](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-providers-oauth.ts:166), remove [useProviderAccountPools.ts:226-230](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useProviderAccountPools.ts:226) | 각 mutation 200 뒤 revision 증가 |
| 수동 새로고침 | `CodexAccountPool`의 `load(true)`가 [useCodexAccountPool.ts:148](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:148)에서 `?refresh=1` | 계정 quota 버튼이 `/accounts?refresh=1` |
| 캐시 무효화 | `sessionStorage.removeItem(quotasCacheKey)` 뒤 next mount의 fixed resource key | `loading=true`와 cold quota request |
| 동시 마운트 | 둘 다 `provider-quotas:${apiBase}` 구독 | Network 한 번, 두 consumer 같은 report |
| 인플라이트 follower | 첫 fetch를 deferred로 둔 뒤 두 번째 구독 | request count 불변, resolve 뒤 둘 다 데이터 |

추가할 전체 테스트 파일은 다음이다. DOM button wiring은 화면 단위 브라우저 activation 표에서 검증하고, 이 파일은 revision contract와 공유 store를 고정한다.

```ts
// gui/tests/provider-revalidation-policy.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests, useKeyedClientResource } from "../src/client-resource";

let win: Window;
let root: Root | null = null;
beforeEach(() => {
  win = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; win.close(); clearClientResourceStoresForTests(); });

test("two quota consumers join one in-flight request and both receive its result", async () => {
  let starts = 0; let release!: (value: { reports: string[] }) => void;
  const pending = new Promise<{ reports: string[] }>(resolve => { release = resolve; });
  const seen: Array<{ reports: string[] } | undefined> = [];
  function Consumer() {
    const resource = useKeyedClientResource("provider-quotas:http://test", [0, false], async () => { starts += 1; return pending; });
    useEffect(() => { seen.push(resource.data); }, [resource.data]);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div"); document.body.append(host);
  await act(async () => { root = createRoot(host); root.render(<><Consumer /><Consumer /></>); });
  expect(starts).toBe(1);
  await act(async () => { release({ reports: ["anthropic"] }); await Promise.resolve(); });
  expect(seen.filter(Boolean)).toHaveLength(2);
  expect(seen.filter(Boolean).every(value => value!.reports[0] === "anthropic")).toBe(true);
});

test("six preservation triggers retain their exact path while the derived account-set key is gone", async () => {
  const pools = await Bun.file("gui/src/hooks/useProviderAccountPools.ts").text();
  const oauth = await Bun.file("gui/src/pages/use-providers-oauth.ts").text();
  const json = await Bun.file("gui/src/hooks/useJsonConfigEditor.ts").text();
  const providers = await Bun.file("gui/src/pages/Providers.tsx").text();
  const shell = await Bun.file("gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx").text();
  const resource = await Bun.file("gui/src/client-resource.ts").text();
  const codex = await Bun.file("gui/src/hooks/useCodexAccountPool.ts").text();
  // account switch; add/remove/login/logout; config save
  expect(pools).toContain("await Promise.all([fetchOauth(), fetchProviderQuotas(true)])");
  expect(pools).toContain("await fetchAccountSets([provider]);\n      await Promise.all([fetchOauth(), fetchProviderQuotas(true)])");
  expect(oauth).toContain("fetchProviderQuotas(true)");
  expect(json).toContain("fetchProviderQuotas(true)");
  // explicit refresh; session-cache cold re-entry; simultaneous mount/follower
  expect(codex).toContain('refreshQuota ? "?refresh=1" : ""');
  expect(shell).toContain("provider-quotas:${apiBase}");
  expect(resource).toContain("if (store.subscriberCount === 1 && store.snapshot.data === undefined)");
  expect(providers).toContain("invalidateProviderQuotas");
  expect(providers).not.toContain("const quotaRefreshKey = useMemo");
});
```

## 재측정 절차

서빙 binary가 아닌 이 checkout의 GUI를 빌드·재기동한 뒤 CDP로 측정한다. 이 WP 문서 작성 단계에서는 실행하지 않는다. 구현 C 단계의 명령은 다음과 같다.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
bun run build:gui
ocx stop
ocx start
```

in-app Browser/CDP에서 `Network.enable({})` 후 다음을 순서대로 실행한다.

```js
await Network.enable({});
await Runtime.evaluate({ expression: 'sessionStorage.clear(); location.hash = "#dashboard"; location.hash = "#providers";' });
// Network.requestWillBeSent를 4,000ms 수집해 URL, method, initiator.stack.callFrames를 JSONL로 저장.
// browser cache off, service worker bypass, previous events clear 상태를 각 run 전 보장.
```

각 시나리오는 독립 새 탭에서 3회 수행하고 URL 목록의 median count를 적는다.

| 시나리오 | 준비 | 통과 |
|---|---|---|
| cold `#providers` | `sessionStorage.clear()`, 새 탭, `#providers` | 4초 `/api/*` ≤25; quota 1, `&quota=1` 0 |
| warm revisit | 첫 mount 완료 뒤 `#dashboard → #providers` | ≤8 |
| explicit refresh | Codex quota refresh click | `/accounts?refresh=1` 존재 |
| OAuth switch | provider account switch click | `/provider-quotas?refresh=1` 정확히 1 |
| login/logout | mock OAuth complete와 logout | mutation 뒤 force quota request |
| config save | JSON editor save | `PUT /config` 뒤 force quota request |

CDP output은 `method url initiator`를 남기되 request/response body, email, account id, authorization header는 저장하지 않는다.

## 활성화 시나리오와 범위

| 분기 | 발화 | 증거 |
|---|---|---|
| fixed key mount | cold mount | quota 1회 |
| force invalidation | switch/login/logout/config save | `?refresh=1` 1회 |
| follower | 두 consumer 동시 mount | request 1, 두 consumer paint |
| hidden passive poll | document를 hidden→visible | hidden tick 0, visible 직후 1 |
| OAuth poll | OAuth waiting 후 tab hidden | 2초 status poll 유지 |

IN: `#providers` quota/account reads, client-resource 공유 사용, 위 polling gates와 회귀 테스트. OUT: `/oauth/status`, key pool, usage, selected-models의 통합·삭제, 폴링 주기 재설계, 서버 `/accounts` fan-out(WP5), API body 계약 변경.
