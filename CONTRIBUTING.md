# Contributing to FrockBot

Contributions are welcome. Terms are defined in [`CONTEXT.md`](CONTEXT.md), how the system is built is in [`docs/architecture.md`](docs/architecture.md), and the conventions every change follows are in [`AGENTS.md`](AGENTS.md).

## Licensing

FrockBot's core is, and stays, [MIT](LICENSE). Anything in this repository is yours to use, change and redistribute under that licence.

Some add-ons are licensed separately: FrockBot for Teams — organisations, SSO and SCIM, admin policy and locks, audit — is a commercial product that is not in this repository and is not MIT. Selling it alongside an MIT core means the project needs the right to license a contribution under terms other than MIT too.

## Contributor Licence Agreement

So before your first pull request can merge, you sign the [FrockBot Contributor Licence Agreement](CLA.md) once. It is adapted from the Apache Individual CLA. You keep the copyright in your work; you grant Tim O'Connell, the project's owner, a licence to use and relicense it, including under commercial terms, and a patent licence for it. Your contribution also remains available to everyone under MIT as part of the core.

Signing takes one comment. When you open a pull request, the `CLA` check comments on it; reply with exactly:

> I have read the FrockBot CLA and I hereby sign it.

The check passes, and your signature is recorded in `signatures/cla.json` on the `cla-signatures` branch. Every author of the pull request's commits must have signed. Comment `recheck` to run the check again, for example after a co-author signs.

Contributing on behalf of an employer that holds rights in your work? Your employer needs to agree too: say so on the pull request and a Corporate CLA will be arranged.

## Pull requests

Pull requests from forks run the `Check` workflow, which needs no secrets. Merging deploys production, so an outside contribution is reviewed and merged by Tim rather than by the automation that merges maintainers' own pull requests.
