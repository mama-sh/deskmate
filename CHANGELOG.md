# Changelog

## [0.2.0](https://github.com/mama-sh/deskmate/compare/v0.1.0...v0.2.0) (2026-07-04)


### Features

* **catalog:** relocate the 5 library roles + their tool-logic tests ([7a6e5a1](https://github.com/mama-sh/deskmate/commit/7a6e5a12bfcc9e379d0e976e90aad59f9726cad9))
* **cli:** deskmate add scaffolds editable role + appends config entry ([3927939](https://github.com/mama-sh/deskmate/commit/3927939ff57f755e74fdcc420c28e46b31643d5f))
* **cli:** deskmate sync generates the agent/ tree from config ([25edafd](https://github.com/mama-sh/deskmate/commit/25edafd822b696dda9cdf9803222b44b8f259257))
* **cli:** sync copies deskmate skills into the generated tree ([40b3166](https://github.com/mama-sh/deskmate/commit/40b3166225ba911bc8b539bbb45b6933bba24097))
* **core:** defineDeskmate builds routing description from config ([9ba8fd1](https://github.com/mama-sh/deskmate/commit/9ba8fd14561c036a9a33a9ccb1d21659190ee909))
* **core:** defineTeam config schema + cross-reference validation ([adc38f5](https://github.com/mama-sh/deskmate/commit/adc38f5dd2cea32ceadea5c130824c5df28e95ed))
* **core:** relocate engine into @deskmate/core, roster-parameterized identity ([32b7558](https://github.com/mama-sh/deskmate/commit/32b7558dba033324e4599509fd2e1b8db5d933ac))
* **example:** config-driven starter app; remove legacy root agent ([d55fdc2](https://github.com/mama-sh/deskmate/commit/d55fdc24374e1248a5041058db79ecf3683e40bf))


### Bug Fixes

* activate channel routing + full sync cleanup + review cleanups ([c4da691](https://github.com/mama-sh/deskmate/commit/c4da69120a407aebb2f625a0b0aa9daeac53a841))
* add seeds connections; sync reads roles/&lt;role&gt;; safe stub env access; mcp-add prefix guard ([4898d8f](https://github.com/mama-sh/deskmate/commit/4898d8f23ad2d8b79ada4e4c3bc6bcf6a5532272))
* byte-exact skill copies; cross-platform package builds ([f53c3bc](https://github.com/mama-sh/deskmate/commit/f53c3bc071947d112dbea216ca0772c8a7b4b213))
* **cli:** committed bin stub so the deskmate bin links at install ([242a027](https://github.com/mama-sh/deskmate/commit/242a027f213d2635bc1d310cd7201ef8728c19b9))
* **cli:** externalize @deskmate/core in generated agent build config ([523cc5a](https://github.com/mama-sh/deskmate/commit/523cc5a2481dea27826c1ae4a5dbda4081cb2431))
* **cli:** top-level error handler prints message, not a stack trace ([3c1adc4](https://github.com/mama-sh/deskmate/commit/3c1adc44021992e6bb75517cfa5211ecc3364177))
* guard CLI ids before fs ops; depth-aware config-key check ([8645b24](https://github.com/mama-sh/deskmate/commit/8645b24d83096f5b872d5e7ab9d25db4862337b3))
* guard role charset; mcp-add no clobber; drop maxTurns from env.example; real root typecheck ([eb0d3da](https://github.com/mama-sh/deskmate/commit/eb0d3da3cc9c380e8caad1a6da23dd1833d7e5c6))
* honor frontDesk.maxTurns; validate synced config; README deps; neutral edit message ([ef5d2c6](https://github.com/mama-sh/deskmate/commit/ef5d2c6ddb3a7663fa96445c87316b452c99d8a7))
* normalize team in defineDeskmate; typecheck test files ([a0219b6](https://github.com/mama-sh/deskmate/commit/a0219b6cd4b6ea260730cd64f3f7f5542fbb4abb))

## 0.1.0 (2026-07-02)


### Features

* add channel-&gt;deskmate route config + resolveRoute (tested) ([d9e46d6](https://github.com/mama-sh/deskmate/commit/d9e46d67c0f494c6b604d73001ea86ee27abd5c9))
* add deskmate:init onboarding wizard with mergeEnv (tested) ([176c3aa](https://github.com/mama-sh/deskmate/commit/176c3aa54f60961c4a22f1ae1f7b6ad0232d689c))
* add deskmate:mcp:add CLI to scaffold custom MCP connections ([f52b9ca](https://github.com/mama-sh/deskmate/commit/f52b9ca7964937748ceaa150fa8ec8d953dc5f57))
* add renderMcpConnection template helper (tested) ([1a08fae](https://github.com/mama-sh/deskmate/commit/1a08faeb5632bb222b52df2e5e7516ede3751f5a))
* add vercel.json so the Deploy button builds eve from source ([6bba4b5](https://github.com/mama-sh/deskmate/commit/6bba4b50bb42d3290d68ff311aa1d4324a4f0d2a))
* ambient Slack thread participation (reply without [@mention](https://github.com/mention), gated) ([e4bb407](https://github.com/mama-sh/deskmate/commit/e4bb407c3dbda63f496b08b927d996671ea9015c))
* convene turn-cap decision helper ([d898973](https://github.com/mama-sh/deskmate/commit/d8989739668fbfd09acd9e2ba9481012536178c5))
* Deskmate — AI deskmates on Eve with a deskmate library + HITL writes ([4bd71a5](https://github.com/mama-sh/deskmate/commit/4bd71a599d06021af0be5f704921db46bbbb23eb))
* deskmate_says tool (voice a deskmate in-thread) ([5feaa96](https://github.com/mama-sh/deskmate/commit/5feaa96b3fa2949dcd111803da0447b6f14ba632))
* deskmateRoster helper for convene delegations ([8949951](https://github.com/mama-sh/deskmate/commit/8949951eb5cd9cc0bdd4c28f7c958a17aa861a6f))
* deskmates collaborate in the open (multi-party threads) ([4f93619](https://github.com/mama-sh/deskmate/commit/4f936194526c5fa2b212c0e1c58d9160b3484d24))
* front-desk convene loop instructions ([93d37d7](https://github.com/mama-sh/deskmate/commit/93d37d788fee6bd8f97069ea6c2882d700061217))
* post Slack replies under each deskmate's name and avatar ([ba40767](https://github.com/mama-sh/deskmate/commit/ba407673eeb98239ced4c1b1d567aaa88a86e052))
* post Slack replies under each deskmate's name and avatar ([a302c4d](https://github.com/mama-sh/deskmate/commit/a302c4d4e74837fd9528c22c5eef5fc7e9ed9495))
* render deskmate_says convene turns + suppress double-post ([39f8b5b](https://github.com/mama-sh/deskmate/commit/39f8b5b222617f8687d549ace04dd24f8767afb4))
* route Slack channels to a deskmate via context injection (default + lock) ([fddc70d](https://github.com/mama-sh/deskmate/commit/fddc70d0530ace8948e7e0e3fe6c64d035da462a))


### Bug Fixes

* address Copilot review — harden the onboarding CLI ([5441ea3](https://github.com/mama-sh/deskmate/commit/5441ea38347c40ada6713b93492ab040cb120dcb))
* address PR [#2](https://github.com/mama-sh/deskmate/issues/2) review (Codex + Copilot) ([190ffc4](https://github.com/mama-sh/deskmate/commit/190ffc45b409dc71efa8c2719d199668495c2767))
* don't drop a convene message on an unanchored thread (PR [#3](https://github.com/mama-sh/deskmate/issues/3), Codex P1) ([b6810d2](https://github.com/mama-sh/deskmate/commit/b6810d2395453008a1ca094250df14a82a8ef3cf))
* form-encode Slack read calls in ambient handler ([e36fa82](https://github.com/mama-sh/deskmate/commit/e36fa82912a1f68e92414220c219fa4b1a5aba5c))
* mergeEnv corrupted secrets containing $ on the update path ([edeb7b7](https://github.com/mama-sh/deskmate/commit/edeb7b7c76cb5814f8c95b64e339f9c6ac274a96))


### Miscellaneous Chores

* set the first release to 0.1.0 ([123c193](https://github.com/mama-sh/deskmate/commit/123c193354cfc9f01f6da79a28227121d6c59678))
