# Contributing to FrockBot

Contributions are welcome. Terms are defined in [`CONTEXT.md`](CONTEXT.md), how the system is built is in [`docs/architecture.md`](docs/architecture.md), and the conventions every change follows are in [`AGENTS.md`](AGENTS.md).

## Licensing

The code in this repository is [MIT](LICENSE) unless a file says otherwise: yours to use, change and redistribute under that licence. The FrockBot name and logo are not covered by it.

Some add-ons are licensed separately: FrockBot for Teams — organisations, SSO and SCIM, admin policy and locks, audit — is a commercial product that is not in this repository and is not MIT. Selling it alongside an MIT core means the project needs the right to license a contribution under terms other than MIT too.

## Contributor Licence Agreement

So before your first pull request can merge, you sign the [FrockBot Contributor Licence Agreement](CLA.md) once. It is adapted from the Apache Individual CLA and governed by the law of New South Wales. You keep the copyright in your work. You grant Tim O'Connell, the project's owner, a licence to use and relicense it, including under commercial terms and in closed-source products, and a patent licence for it. You also consent to it being used without crediting you by name, and to products that include it being presented as FrockBot's; the git history still records you as its author. In return, whatever of yours is merged is licensed to everyone under MIT for good, even if it is later changed or removed. The agreement can pass to a company Tim controls or co-founds, or to a buyer of the project or of FrockBot for Teams, and that MIT licence goes with it.

Signing takes one comment. When you open a pull request, the `CLA` check comments on it; reply with a new comment, not a quote-reply, consisting of only this sentence, with nothing before or after it:

> I have read the FrockBot CLA version 1.0 and I hereby sign it.

The check passes, and your signature is recorded in `signatures/cla-v1.0.json` on the `cla-signatures` branch. If nothing happens, or your signature did not register, comment `recheck`.

Each commit is matched to the GitHub account of its author, or of its committer when the author's email is linked to no account, and every matched account must have signed. So commit with an email that is on your GitHub account (a GitHub noreply address works). A commit whose author and committer emails are both unlinked, such as one an AI tool authored and committed under its own name, can never be signed for: amend it to your own identity, push, and comment `recheck`. The account that opened the pull request must have signed too. People credited only in a `Co-authored-by` line are not checked and cannot be recorded, so a co-author should author a commit of their own on the pull request and sign.

If you are under 18, a parent or guardian must also email Tim, with your GitHub username, consenting to you signing. You still sign yourself.

If your employer, or a client you are contracting for, owns or has rights in your work, they either authorise you in writing to sign for them, or sign the [Corporate CLA](CCLA.md) and list you in its Schedule A. Email Tim to arrange it. You still sign yourself.

A pull request that changes fewer than five lines of text in total and no binary or generated file, such as a typo fix, passes the check without a signature. It is submitted under the MIT License.

## Pull requests

Pull requests from forks run the `Check` workflow, which needs no secrets. Merging deploys production, so an outside contribution is reviewed and merged by Tim rather than by the automation that merges maintainers' own pull requests.
