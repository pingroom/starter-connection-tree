# PingRoom connection tree starter

Collect candidate link costs through PingRoom and propose the cheapest tree connecting every site. Use it to choose connections after a named installation planner supplies quotes.

The four-desk example exports a local plan. It performs no installation, deployment or purchase.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

Five demos use the real SDK with local mock transport to cover ordinary costs, free links, unavailable links, disconnection and Unknown. They need no credentials and do not test live phone delivery. `@pingroom/sdk` 0.7.1 is pinned with a lockfile; `.npmrc` requests a 14-day minimum release age where npm supports it. GitHub Actions checks Node 22 and 24.

## Define the connections

```sh
cp examples/network.json network.json
cp config.example.json config.json
npm run validate
```

Edit `network.json` before collecting quotes:

- `planId`, `title` and `context` identify one installation plan or quote window.
- `costUnit` and `costDefinition` state the shared unit and what each quoted total includes.
- `sites` contains two to six `{id,label}` records.
- `links` contains one to eight `{id,from,to,label}` candidate undirected connections.

Use comparable costs for links that can coexist, such as total installation labor points. Code cannot verify quotes or discover omitted costs. Isolated sites are allowed. Duplicate unordered pairs, self-links and unknown endpoints are rejected.

Site/link IDs use 1–16 lowercase ASCII characters, starting with a letter, followed by letters, digits, `_` or `-`; prototype-related names are excluded. The plan ID allows 40 characters. Trimmed single-line Unicode limits are title 40, context 60, cost unit 20, cost definition 60, site label 24 and link label 30 UTF-16 units. Controls, formatting characters and malformed Unicode are rejected. Full prompts must fit 500 characters.

Sites and links are sorted by ID, and each link's endpoints are sorted. Reordering arrays or swapping endpoints preserves the session.

## Connect the planner

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Open the pairing link, approve the connection and grant a standard private room containing the planner. Verify the person in the app, then copy their exact member UUID from `inspect` into `config.json`. Names alone do not establish identity. The connection needs room/Question access; keep the original asking registration for later reads.

Pairing resumes pending requests and stores credentials under `.pingroom/`. For an existing connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Complete pairs override saved credentials; partial or blank shell pairs cannot borrow missing values.

## Collect and export

```sh
npm start
# Answer in PingRoom, then record that answer:
npm start
npm run status
npm run report
npm run export
npm run export-analysis
```

Each `npm start` creates at most one Question or reads the active one once. After recording an answer, run it again for the next link in ID order. Prompts include endpoint IDs/labels, link description, context and full cost meaning. At most eight Questions target the planner, each lasting 900 seconds. There is no background polling.

Reply with an integer `0`–`999999` without leading zeros, exactly `Unavailable`, or exactly `Unknown`. Zero is a free connection. Unavailable means the candidate cannot be used; Unknown means its cost/availability is unresolved. Parsing checks PingRoom's normalized text and cannot detect whitespace trimmed by the server.

Every link needs a known outcome. Unknown, missing, invalid, expired or cancelled answers withhold the whole analysis, even if other links already connect the sites. Later links can still be collected, but terminal Questions are never automatically reissued.

These commands work offline:

| Command | Output |
| --- | --- |
| `status` | Prints status and current evidence. |
| `report` | Saves `.tree/report.json`, including partial evidence. |
| `export` | Writes `.tree/proposal.json` only for a complete connected result. |
| `export-analysis` | Writes `.tree/analysis.json` for any complete known result. |

Disconnected known inputs produce `connectable: false`, `reason: "disconnected"`, sorted `components` and `tree: null`. Analysis export succeeds; proposal export refuses the result. A connected all-zero-cost tree is valid and exportable.

Exports retain inputs, policy hashes, room, planner, attributed quotes, Question IDs and timestamps. Repeated exports are identical. Failure preserves prior files; require successful export for the expected source hash.

## Read the tree

The [Kruskal algorithm](https://algs4.cs.princeton.edu/43mst/index.php) considers available links by cost, then ASCII edge ID, adding only links that join separate components. A connected result contains exactly `sites.length - 1` links. BigInt addition exports `tree.totalCost` as an exact decimal string in the declared unit.

`tree.edgeIds` records selection order; `tree.links` includes endpoints and quoted costs. For each available unselected edge, `replacementChecks` shows the selected path between its endpoints, its maximum edge cost, the edges attaining that maximum and the replacement cost difference. Connectivity and these checks verify minimum cost for the declared graph. Equal-cost alternatives may exist; the ID rule selects one deterministically.

The model assumes independent additive costs and undirected links. It gives no capacity, degree, redundancy or travel-route guarantee. One failed link disconnects a tree. The certificate cannot verify installation feasibility.

## Recover and adapt

Preserve the original network, config, connection and `.tree/` directory. Changed content, policy or identities cannot reuse answers. Creation intent is saved before POST. Recover uncertain creation with:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

An empty recent-list search does not prove creation failed. Recovery checks the original Question without another POST. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pairing record.

Use persistent storage on one machine. Restore corrupt state from backup; remove stale locks only after confirming their owning process stopped. Credentials, inputs and state are Git-ignored. Writes are private and atomic. Limits: network 64 KiB, config 16 KiB, state/reports 1 MiB, HTTP responses 512 KiB. Evidence is historical, not tamper-proof.

Collection exits `0` when complete, `1` on error, `2` for incomplete/newly failed outcomes, `3` while ready/pending/interrupted and `4` for uncertain creation. Complete disconnected results also exit `0`; inspect `analysis.connectable`. Successful offline commands exit `0`; refused exports exit `1`.

Adapt the network and review its proposal before use. Keep validation and execution in code; version `POLICY` when semantics change. The [SDK contract](https://github.com/pingroom/sdk) was checked on 2026-11-07. Tests include 10,657 independent spanning-subset comparisons, certificate checks, interrupted writes, pairing and CLI subprocesses. [MIT license](LICENSE).
