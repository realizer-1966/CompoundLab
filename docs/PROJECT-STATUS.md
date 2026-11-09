# CompoundLab — 프로젝트 정리 (2026-11-09 기준)

> 두 저장소의 병합: **laya-rag-judge-ko** (브라우저 네이티브 RAG 주장 판별기 한국어판, Apache-2.0)
> × **advancedRagDemo** (고급 검색/수집/생성/Lab 기능, MIT) → **CompoundLab**
> 원본: vishalmysore/layaAsRagJudge · vishalmysore/advancedRagDemo

- 저장소: https://github.com/realizer-1966/CompoundLab (public)
- 배포: https://realizer-1966.github.io/CompoundLab/ (GitHub Pages, CI 자동 배포, PWA)
- 로컬 개발: `npm ci && npm test && node scripts/prepare_site.mjs && python serve.py 8769`

---

## 1. 최종 아키텍처

```
[수집] PDF(pdf.js+vCMaps)/TXT/MD → 한국어 안전 정규화 → 문장 청킹 → 다국어 MiniLM 임베딩 → IndexedDB
[검색] 코사인(brute-force) + 한국어 2-gram BM25 하이브리드 (가중치 슬라이더) + 근접성 리랭킹
[판별] 브라우저 Laya ONNX (mmBERT)  또는  Ollama Clef (/v1/systemone 어댑터)
[게이트] p(지지됨) + 신뢰도 → AUTO / BLOCK / HOLD (컷오프·기준선 슬라이더)
[생성] Ollama /api/chat (glm-5.3-flash:cloud) 또는 Mock AI(추출형, 환각 0) → 문장별 [n] 인용
[검증] 생성된 답변의 문장마다 판별기 → 배너 경고 (advancedRagDemo 정규식 배너를 실제 판별기로 대체)
```

**6개 페이지**: 주장 검증(index) · 평가(rag-eval) · 라우터(router) · 질의응답(chat) · 청킹 Lab(lab) · 프로덕션 Lab(production)
**데이터 전송 경계**: 검색·수집·벡터는 전부 이 브라우저(IndexedDB). Ollama 백엔드 선택 시에만 주장/근거/답변 문장이 Ollama 서버(→ `:cloud` 태그면 ollama.com 클라우드, 유료)로 전송. 완전 오프라인 조합 = 브라우저 Laya + Mock AI.

---

## 2. 진행 요약 (커밋 계보)

| 단계 | 커밋 | 내용 |
|---|---|---|
| 시작점 | `ff79b12` | laya-rag-judge-ko 한국어판 클론 |
| **Phase 1** | `7c15439` | 한국어 하이브리드 검색: 한글 run을 겹치는 문자 2-gram으로 토큰화(구 구현은 한국어 토큰 0개) → BM25 유효화. 근접성 리랭커(k-list 최소 윈도 스윕). 평가 페이지에 검색기 비교(벡터/키워드/하이브리드/±리랭킹, Laya 불필요). runKey 하위호_env 호환(ret: 접미사) |
| **Phase 2a** | `6ad7f3a` | Ollama Clef 판별기 백엔드 — Laya의 systemOne(state, questions) 인터페이스를 그대로 `/v1/systemone`으로 전달. 응답 형태(probabilities/noul/usage)가 동일해 interpret·게이트·지표 코드 무수정 병합. 헬스체크·`?clefBase=`·모델 카드 백엔드 선택 UI |
| **Phase 2b** | `03ce9c7` | 질의응답 페이지: PDF/TXT/MD 수집(pdf.js 로컬 벤더링+CMaps, glyph 간격 공백으로 한국어 단어 보존), **한국어 안전 정규화**(advancedRagDemo의 ASCII 정규화는 한글을 파괴 — 회귀 테스트로 감시), Ollama 채팅 생성 + Mock AI, 문장별 판별 게이트 |
| **Phase 3** | `c67d62e` | 청킹 Lab(5종 전략×완전 근거 회수, 청크 그래프 SpectRAG-lite, 한국어 "x.y절" 참조) · 프로덕션 Lab(9개 장애 모드 결정론 시뮬레이션 + 카오스 위크 등급) · chat 트레이스 콘솔 · 6탭 네비 |
| **CI 수정** | `0148d23` | Pages enablement + 모델 체크 URL을 multilingual 매니페스트로 |
| **PWA** | `a61f963` | manifest·아이콘(순수 파이썬 PNG 생성)·COI 서비스워커에 오프라인 앱 캐시를 겸함 |
| **안정화** | `783364a`~`2117bb7` | Ollama 트러블슈팅 안내, lab UI 회귀(render 누락) 수정 + UI 하네스 테스트, SW 네트워크-first + 방문마다 reg.update() + 캐시 세대 v4 |

**테스트 52개 전부 통과** — CI가 매 푸시마다 재검증 후 배포. UI 결함(브라우저에서만 나타나는)은 가짜 DOM 하네스(`tests/lab-ui.test.mjs`: 실제 클릭 → runLab → render → 4개 뷰 그려짐 → 자동 스크롤)이 방어선.

---

## 3. 실측 데이터

### 판별기 비교 (choice2 질문, 같은 코퍼스)

| | 브라우저 mmBERT (기록) | Ollama clef:cloud (실측) |
|---|---|---|
| 스모크 일치 | 62.5% 수준 | **6/6** |
| 신뢰도 | 압축(게이트 0.10 필요) | **0.79~0.90** (게이트 0.3+) |
| 지연 | ≈2.6 s (WASM) | ≈0.5–1.0 s |

### 청킹 Lab (한국어 샘플, L=160, 전체 질문)

구조 인식 = 경계 100%·xref 해결 100% / QES 겹침 탐욕 = 검색 회수 최고(0.55@예산 30) / 고정·문장 윈도 = 완전 회수 낮음 — **"지도된 청킹(QES) > 구조 > 베이스라인" 순서 재현**.

### 프로덕션 Lab (한국어 가상 규정 + KB 36)

- 문서 ID: 편집 1건 임베딩 230회 → 14회
- 안정 청킹: 해시 재사용 후 연쇄 11개 → 1개
- 버저닝: 크래시 후 인덱스가 "연차 15일과 20일"을 섞어 답함 → v12만
- 모델 업그레이드: recall@5 98% → 24%(혼합) → 버저닝으로 99%
- 카오스 위크: fix 없이 **1/7(F)** → 전부 켜면 **7/7(A)**

---

## 4. 트러블슈팅 기록 (재발 방지)

1. **Ollama CORS** — `OLLAMA_ORIGINS="*"` 없이는 외부 오리진 거부. 이 기기 서버는 그렇게 상시 실행 중. 자세한 것은 README-ko "트러블슈팅" 참조.
2. **Chrome 내부망 접근 차단(Private Network Access)** — 공개 https 페이지 → 기기 로컬 Ollama는 막을 수 있음. 대안: 같은 기기 `http://localhost:8769`(로컬↔로컬) 또는 브라우저 Laya.
3. **서비스워커 캐시로 이전 코드 서빙** — SW 스크립트가 호스트 10분 HTTP 캐시에 묶이는 문제 → `updateViaCache:"none"` + 방문마다 `reg.update()` + 모듈/데이터 network-first + 캐시 세대 상승. 진단 방법: 페이지 자체의 "빌드 2026-11-09.2" 식별자.
4. **UI 회귀 2건**(retrieve 미import, render() 호출 누락) — Node 단위 테스트는 통과하고 브라우저에서만 발생. 교훈: **UI 코드는 가짜 DOM 하네스 실행으로 검증** (이제 CI가 한다).
5. **로컬 dist 만료** — 커밋+푸시 전 `node scripts/prepare_site.mjs` 누락 없이 (로컬 서버에는 dist가 소스).

---

## 5. 미해결 후속 과제 (우선순위 순)

1. **clef:cloud 72주장 정식 벤치마크 녹음** — 평가 페이지 전체 실행 → `__lrj.recorded()` → `web/recorded.json` 갱신 → 사이트 기록값 배포 (mmBERT 62.5% 대비 확실한 성능 데이터 확보)
2. **차단 문장 재생성 루프** — 질의응답에서 BLOCK 문장 자동 재생성(+1회 판별)
3. **라우터 clef:cloud 재측정** — mmBERT에서 28%였던 라우팅이 Clef로 개선되는지 확인(rung 판별 질문도 System One이라 바로 교체 가능)
4. **SpectRAG 조립을 chat 검색에** — 청킹 Lab의 그래프 조립을 실질 검색에 적용
5. Actions 경고: actions v4/v5의 Node20 강제 경고(무해) — 추후 버전 상승 시 대응

---

## 6. 운영 명령

```bash
# 로컬 개발
npm ci && npm test && node scripts/prepare_site.mjs && python serve.py 8769

# Ollama 판별 서버 (이 기기, CORS 허용, 127.0.0.1 바인딩)
OLLAMA_ORIGINS="*" ollama serve

# 배포: 그냥 main push → CI가 테스트+dist 조립+Pages 배포
git push origin main
```
