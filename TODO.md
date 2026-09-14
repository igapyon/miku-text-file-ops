# CLI レビュー指摘の修正計画

## 引き継ぎと作業範囲

- 計画作成日: 2026-09-14
- 対象: `miku-text-file-ops` CLI v0.5.0 → v0.6.0
- 変更背景: Astra レビュー後の修正対応。完了後のリリースバージョンは `0.6.0` とする。
- 次の担当: GPT-5.6 Luna を含む実装担当エージェント
- このファイル作成後、ユーザーの実装指示を受けて P1 → P2 の順に対応済み。
- 実装結果と検証結果をこのファイル末尾まで反映する。
- スキルの変更、バージョン更新、依存関係更新、コミット、push、リリースは対象外。
- 修正前の `npm test` は 166 件成功。これだけでは以下の不具合を検出できない。

## P1: `.git` 保護の大文字・小文字による回避を防ぐ

### 原因と再現事実

`src/contracts/requests.ts` の `validateWorkspacePath()` は、変更対象の
先頭パス要素を `segments[0] === ".git"` で判定している。
CREATE・UPDATE・DELETE のリクエスト検証はこの判定を共有する。

大文字・小文字を区別しない、このレビューで使用した Mac のファイルシステムでは、
一時ワークスペース内に `.git` ディレクトリを用意し、次の CREATE を実行すると
終了コード 0 / `status: "success"` となり、実際の `.git/review-probe` が作成された。

```json
{"path":".GIT/review-probe","content":"probe"}
```

### 採用する修正方針

ルート直下の `.git` という名前を ASCII 大文字・小文字を区別せず予約し、
その配下と名前そのものへの変更を全 OS で拒否する。
先頭要素への `/^\.git$/i` 等の限定的な判定で実装できる。
大小文字を区別する OS でも `.GIT` を予約名とする、意図的な保護範囲の拡張である。

パス全体の小文字化や書き換えはしない。READ の許可範囲や、入れ子のリポジトリ、
別の Windows パス別名対策まで今回の修正を拡張しない。
この修正だけで全種類のファイルシステム別名を防いだとは主張しない。

### 実装タスク

- [x] `test/contracts/requests.test.ts` に先に回帰テストを追加する。
  CREATE・UPDATE・DELETE それぞれで `.git/config`、`.GIT/config`、
  `.GiT/config`、`.GIT` が `protected_path` となることを検証する。
  UPDATE・DELETE には正しい形式の revision を渡し、別の検証エラーと混同しない。
- [x] `.gitignore`、`.github/config`、`.gitkeep` が保護名として誤拒否されないこと、
  READ の `.GIT/config` リクエスト自体はこの変更で拒否されないことを確認する。
- [x] `validateWorkspacePath()` の変更対象パス判定を上記方針に変更する。
  エラーコードと診断の構造は維持する。
- [x] `test/cli/cli.test.ts` の既存の一時ワークスペース作成方法を利用し、
  `executeCli()` 経由で CREATE・UPDATE・DELETE の保護を検証する。
  テスト専用ディレクトリの `.git/config` に既知の内容を置き、
  `.GIT/config` への変更・削除と `.GIT/new.txt` の作成を試す。
  終了コード 2、`status: "failed"`、`protected_path`、元のバイト列の不変、
  新規ファイルが作成されないことを確認する。
  判定を全 OS 共通にするため、この回帰テストは大小文字を区別する環境でも実行する。
- [x] `docs/specification.md` の Workspace and Path Boundary に、
  ルート直下の `.git` は ASCII 大文字・小文字を問わず変更禁止であることを明記する。

### 完了条件

上記の変種が 3 操作すべてでファイル操作前に拒否され、通常パスへの変更が従来どおり動く。
実際のリポジトリの `.git` を再現実験に使用しない。

## P2: 走査失敗を検索件数・集計の確定判定に伝える

### 原因と再現事実

`src/fs/workspace.ts` の `Workspace.scan()` は、ディレクトリ読み取り失敗や
不正な `.gitignore` を `scan.diagnostics` に `source_error` として返す。
しかし `src/core/search.ts` の `executeSearch()` は、下位の検索処理に渡す
`discoveryComplete` を `!scan.truncated` だけで決めている。

内容検索の `fileTotalsExact` と facet の `exact` は、
`scanComplete && filesSkipped === 0` に依存する。
`filesSkipped` は候補ファイルの読み取り・デコード失敗の数であり、走査失敗を含まない。

一時ワークスペースに次を用意する。

- `.gitignore`: バイト列 `[0xff]`（不正な UTF-8）
- `a.txt`: `needle\n`

```json
{"mode":"content","projection":"summary","pattern":"needle","include":["*.txt"]}
```

現状は `source_error` と `status: "partial"` を返しながら、
`scanComplete: true`、`filesMatched: 1`、`matchesFound: 1`、facet の
`exact: true` を返す。走査が不完全なのに確定した集計として扱われる問題である。

### 採用する修正方針

`scan.truncated` と走査診断から、候補の発見が完全だったかを
`executeSearch()` 内で一度だけ決め、パス検索と内容検索の両方に伝える。
現行の走査診断は `source_error` のみなので、診断の有無を利用できる。
将来別種の診断を追加する場合の意味が分かる命名・短いコメントにする。

既存の `limit_clamped` 等を含む全診断や `status !== "success"` から、
無条件に走査失敗を推定しない。走査失敗と、出力件数・文字数・バイト数の制限は区別する。

### 実装タスク

- [x] `test/core/search.test.ts` に上記の壊れた `.gitignore` の回帰テストを追加する。
  `include: ["*.txt"]` を付け、候補ファイルのデコード失敗ではなく
  走査診断だけが原因になるようにする。
- [x] 内容検索の `summary` で次の期待値を検証する。
  `status: "partial"`、`completeness.complete: false`、理由に `source_error`、
  `scanComplete: false`、`filesMatched: null`、`matchesFound: null`、
  `filesMatchedAtLeast: 1`、`matchesFoundAtLeast: 1`、全 facet の `exact: false`。
  下限値は実際に観測した候補についての値とし、ignore 適用が正常だったとは主張しない。
- [x] 同じ原因について、内容検索の `count` とパス検索の `count` / `summary` も確認する。
  パス検索ではファイル件数と facet の確定判定、`scanComplete: false` を検証する。
- [x] `executeSearch()` で走査の完全性を計算し、両検索処理に渡す。
  facet と summary が同じ完全性に基づくことを確認する。
- [x] `executePathSearch()` 内の `if (!scanComplete)` に注意する。
  現状はここで `file_visit_limit` を追加しているため、上記変更だけでは
  走査エラーまで件数制限として報告してしまう。
  件数制限の理由は `executeSearch()` の `scan.truncated` 判定で付与し、
  走査エラーのみの場合に `file_visit_limit` が出ないよう整理・テストする。
- [x] 診断の省略が完全性判定を消さないことをテストする。
  例えばルートとサブディレクトリに壊れた `.gitignore` を置き、
  `maxDiagnostics: 1` で診断が省略されても件数は非確定のままになることを確認する。
- [x] 正常な `.gitignore` で同じ検索を行う対照ケースでは、
  `success`、`scanComplete: true`、確定件数、facet の `exact: true` を維持する。
- [x] 既存の `SEARCH maxFilesVisited stops before later directory diagnostics` テストを維持する。
  件数上限後に追加走査する設計へ変更しない。
- [x] `docs/specification.md` の Completeness / Ignore and Glob Contract に、
  走査失敗時は summary と facet も非確定になることを必要最小限で追記する。

### 完了条件

走査の `source_error` が出た検索は、診断表示数や projection にかかわらず
ワークスペース全体の件数・facet を確定値として返さない。
正常な検索や、既存の制限・診断集約の挙動を壊さない。

## 検証と引き渡し

- [x] 回帰テストを修正前に実行し、意図した不具合で失敗することを確認する。
  `npm run build` 後、必要なテストを `node --test dist/test/contracts/requests.test.js dist/test/cli/cli.test.js dist/test/core/search.test.js` で実行できる。
- [x] 2 件の実装修正後に `npm test` を実行し、追加テストを含めて全件成功を確認する。
- [x] 配布 CLI も検証するため、`npm run build:bundle`、`npm run smoke:bundle`、
  `npm run smoke:runtime` を実行する。失敗した場合は原因と修正範囲の関係を確認する。
- [x] `git diff --check` と `git diff` で、上記 2 件に関係する変更だけであることを確認する。
- [x] 完了した項目だけチェックし、変更内容・テスト結果・未検証の OS 条件をユーザーに報告する。
  コミットや公開は実施しない。

## 実装結果

- `validateWorkspacePath()` はルート直下の `.git` を ASCII 大文字・小文字を問わず、CREATE・UPDATE・DELETE で保護する。
- 検索は走査診断が診断上限で省略されても、候補発見を非完全として扱い、件数と facet を下限値・`exact: false` で返す。
- 回帰テストを追加し、仕様書に両方の契約を追記した。
- `npm test`: 170 件成功。
- `npm run build:bundle && npm run smoke:bundle && npm run smoke:runtime`: 成功。
- 変更後の実行環境は macOS のみ。Windows と Linux の実ファイルシステムでの実行は未検証。
