# Contributing to FrockBot

Contributions are welcome. Terms are defined in [`CONTEXT.md`](CONTEXT.md), how the system is built is in [`docs/architecture.md`](docs/architecture.md), and the conventions every change follows are in [`AGENTS.md`](AGENTS.md).

## Licensing

The code in this repository is [MIT](LICENSE) unless a file says otherwise: yours to use, change and redistribute under that licence. The FrockBot name and logo are not covered by it.

Some add-ons are licensed separately: FrockBot for Teams — organisations, SSO and SCIM, admin policy and locks, audit — is a commercial product that is not in this repository and is not MIT. Selling it alongside an MIT core means the project needs the right to license a contribution under terms other than MIT too.

## Contributor Licence Agreement

So before your first pull request can merge, you sign the [FrockBot Contributor Licence Agreement](CLA.md) once. It is adapted from the Apache Individual CLA and governed by the law of New South Wales. You keep the copyright in your work; you grant Tim O'Connell, the project's owner, a licence to use and relicense it, including under commercial terms, and a patent licence for it. In return, the CLA promises that whatever of yours goes into this repository stays available to everyone under MIT. The agreement, and that promise, can pass to a company Tim forms or to a buyer of the project.

Signing takes one comment. When you open a pull request, the `CLA` check comments on it; reply with exactly:

> I have read the FrockBot CLA version 1.0 and I hereby sign it.

Post it as a new comment, not a quote-reply. The check passes, and your signature is recorded in `signatures/cla-v1.0.json` on the `cla-signatures` branch. Every author of the pull request's commits must have signed; people credited only in a `Co-authored-by` line are not checked automatically, so ask them to sign on the pull request too. If nothing happens, comment `recheck`.

Does your employer hold rights in your work? Then it is not accepted until your employer has agreed to the CLA's terms in writing: say so on the pull request and it will be arranged.

## Pull requests

Pull requests from forks run the `Check` workflow, which needs no secrets. Merging deploys production, so an outside contribution is reviewed and merged by Tim rather than by the automation that merges maintainers' own pull requests.
