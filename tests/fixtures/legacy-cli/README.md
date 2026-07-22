# mancode 0.3.18 CLI fixture

`mancode-0.3.18.tgz` is the unmodified public npm package used by the
black-box V2 compatibility contract.

- Package: `mancode@0.3.18`
- npm integrity: `sha512-7jqphIAgW+XlTZWFwK06ekPOt//g4q9A+3KZJeSjZCdh3d4Rsb0Akgn3ku5Ayc1URZAtPJVPqLdqgxfCaszlWg==`
- npm shasum: `f3b14e98a3426bf3f2cf6f2461698c9bd4c52d13`
- Release commit: `a0f39f75d50f3ff2e985cd3e45cc250100710e45`
- npm registry `gitHead`: `ff407d7b07c18d9b56cdf3a7e0bf35f2d9921fef`

To verify the registry metadata without changing the fixture:

```bash
npm view mancode@0.3.18 version dist.integrity dist.shasum
npm pack mancode@0.3.18 --dry-run --json
```

Do not replace this fixture with a root dev dependency alias. npm exposes the
aliased package's `mancode` binary in `node_modules/.bin`, which would make
repository commands run the legacy CLI instead of the current build.
