# Contributing to FrockBot

Contributions are welcome. Terms are defined in [`CONTEXT.md`](CONTEXT.md), how the system is built is in [`docs/architecture.md`](docs/architecture.md), and the conventions every change follows are in [`AGENTS.md`](AGENTS.md).

## Licensing

The code in this repository is [MIT](LICENSE) unless a file says otherwise: yours to use, change and redistribute under that licence. The FrockBot name and logo are not covered by it.

Some add-ons are licensed separately: FrockBot for Teams — organisations, SSO and SCIM, admin policy and locks, audit — is a commercial product that is not in this repository and is not MIT. Selling it alongside an MIT core means the project needs the right to license a contribution under terms other than MIT too.

## Contributor Licence Agreement

So before your first pull request can merge, you sign the [FrockBot Contributor Licence Agreement](CLA.md) once. It is adapted from the Apache Individual CLA and governed by the law of New South Wales. You keep the copyright in your work. You grant Tim O'Connell, the project's owner, a licence to use and relicense it, including under commercial terms and in closed-source products, and a patent licence for it, and you consent to it being used without crediting you by name. In return, whatever of yours is merged is licensed to everyone under MIT for good, even if it is later changed or removed. The agreement can pass to a company Tim forms or to a buyer of the project, and that MIT licence goes with it.

Signing takes one comment. When you open a pull request, the `CLA` check comments on it; reply with a new comment, not a quote-reply, containing exactly:

> I have read the FrockBot CLA version 1.0 and I hereby sign it.

The check passes, and your signature is recorded in `signatures/cla-v1.0.json` on the `cla-signatures` branch. If nothing happens, or your signature did not register, comment `recheck`.

Every author of the pull request's commits must have signed, and the check can only match a commit to you when its email is one on your GitHub account (a GitHub noreply address works). A commit with any other email, including one authored by an AI tool under its own name, can never be signed for: amend it to your own identity, push, and comment `recheck`. People credited only in a `Co-authored-by` line are not checked and cannot be recorded, so a co-author should author a commit of their own on the pull request and sign.

Do not sign if you are under 18, or if your employer or anyone else holds rights in your work and has not agreed to the CLA's terms in writing: say so on the pull request and it will be arranged or the contribution declined.

## Pull requests

Pull requests from forks run the `Check` workflow, which needs no secrets. Merging deploys production, so an outside contribution is reviewed and merged by Tim rather than by the automation that merges maintainers' own pull requests.
