import { useState } from "preact/hooks";
import { useSetup } from "../state.ts";
import { microsToDollars } from "../model.ts";
import { PageHead, Pill, Soon } from "../ui.tsx";

type Host = "frockbot" | "sprites" | "server" | "mac";

const HOSTS: { id: Host; name: string; detail: string }[] = [
  {
    id: "frockbot",
    name: "FrockBot’s computer",
    detail:
      "A cloud Linux desktop we run. Always on, paid from credit while it works.",
  },
  {
    id: "sprites",
    name: "Your Sprites",
    detail: "The same computer on your own Fly.io account.",
  },
  {
    id: "server",
    name: "Your server",
    detail: "Any Linux VPS or home server. No open ports needed.",
  },
  {
    id: "mac",
    name: "Your Mac",
    detail: "A Linux VM the Mac app runs for you. Mac app only.",
  },
];

/** Where the steps for a host of the person's own will go once it opens. */
function Steps({ host }: { host: Host }) {
  if (host === "server")
    return (
      <div class="stack-16">
        <div class="stack-8">
          <h3 class="h3">1. Run this on your server</h3>
          <div class="code" aria-disabled="true">
            <span>The install command appears here.</span>
          </div>
          <span class="small">
            It installs everything your bots need, including a desktop you can
            watch and take over.
          </span>
        </div>
        <div class="stack-8">
          <h3 class="h3">2. Enter the code it prints</h3>
          <div class="wrap-8">
            <input
              class="field-input mono"
              aria-label="Pairing code"
              placeholder="XXXX-XXXX"
              disabled
            />
            <button type="button" class="btn primary" disabled>
              Pair
            </button>
          </div>
          <span class="small">
            The code works once and expires after five minutes. Your server
            connects out to FrockBot, so nothing needs to reach it.
          </span>
        </div>
      </div>
    );
  if (host === "sprites")
    return (
      <div class="stack-8">
        <h3 class="h3">Connect your Fly.io account</h3>
        <p class="body muted">
          Add a Fly.io token and FrockBot runs the same computer on your own
          account, billed by Fly.io.
        </p>
      </div>
    );
  return (
    <div class="stack-8">
      <h3 class="h3">Turn it on in the Mac app</h3>
      <p class="body muted">
        The Mac app runs a Linux computer for your bots while it’s open.
      </p>
    </div>
  );
}

export function ComputerPage() {
  const { data } = useSetup();
  const [looking, setLooking] = useState<Host>("frockbot");
  const computer = data.spending?.groups.find(
    (group) => group.key === "computer",
  );
  const rate = data.billing?.computerRate?.activeUsdPerHour;
  return (
    <>
      <PageHead
        title="Computer"
        lede="Every bot shares one computer, with a desktop you can watch. It browses, runs code and downloads things."
      />
      <section class="stack-12">
        <h2 class="h2">Where it runs</h2>
        <div class="grid-4">
          {HOSTS.map((host) => (
            <button
              type="button"
              key={host.id}
              class={`opt${looking === host.id ? " on" : ""}`}
              aria-pressed={looking === host.id}
              onClick={() => setLooking(host.id)}
            >
              <span class="radio" />
              <span class="stack-4">
                <span class="wrap-8">
                  <span class="row-title">{host.name}</span>
                  {host.id === "frockbot" ? (
                    <Pill tone="ok">Current</Pill>
                  ) : (
                    <Soon />
                  )}
                </span>
                <span class="small">
                  {host.id === "frockbot" && rate
                    ? `A cloud Linux desktop we run. Always on. US$${rate.toFixed(2)} per active hour from credit.`
                    : host.detail}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>
      {looking === "frockbot" ? (
        <section class="card pad-20 stack-8">
          <h2 class="h2">FrockBot’s computer</h2>
          <p class="body muted">
            {computer && computer.chargeMicros > 0
              ? `Your bots’ computer has used ${microsToDollars(computer.chargeMicros)} of credit ${data.billing?.subscribed ? "this month" : "in the last 30 days"}.`
              : "Your bots’ computer starts when a bot needs it and sleeps when they’re done."}
          </p>
        </section>
      ) : (
        <section class="card pad-20 split">
          <div class="stack-12">
            <div class="wrap-8">
              <h2 class="h2">{HOSTS.find((h) => h.id === looking)!.name}</h2>
              <Soon />
            </div>
            <Steps host={looking} />
          </div>
          <div class="aside stack-12">
            <h3 class="h3">When you switch</h3>
            <ul class="body plan-list">
              <li>Your bots move to the new computer as soon as it’s ready.</li>
              <li>
                FrockBot’s computer is deleted, with its files and installed
                apps.
              </li>
              <li>
                Sign-ins you saved on the computer are kept and restored there.
              </li>
              <li>
                A computer of your own only works while it’s on. If it’s
                offline, your bots say so.
              </li>
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
