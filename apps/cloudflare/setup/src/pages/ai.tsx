import { useMemo, useState } from "preact/hooks";
import {
  addProvider,
  connectKey,
  replaceKey,
  setChatModel,
  setImageModel,
} from "../actions.ts";
import { loadSetup, useSetup, type SetupData } from "../state.ts";
import {
  chatModels,
  chatOf,
  FROCK_AI_PACKAGE_ID,
  IMAGE_MODELS,
  imageModelOf,
  jobsOf,
  listWords,
  matchProviders,
  providersOf,
  usesOf,
  type Connection,
  type Job,
  type Provider,
} from "../model.ts";
import {
  Dialog,
  Field,
  Icon,
  Notice,
  PageHead,
  Pill,
  Problem,
  Segmented,
  Soon,
  useAction,
} from "../ui.tsx";

const GROUP_LABELS = {
  frockbot: "FrockBot",
  popular: "Popular",
  all: "All providers",
} as const;

function stateWords(provider: Provider): {
  tone: "ok" | "bad" | "neutral" | "ready";
  text: string;
} {
  switch (provider.state) {
    case "built-in":
      return { tone: "ready", text: "Built in" };
    case "connected":
      return { tone: "ok", text: "Connected" };
    case "refused":
      return { tone: "bad", text: "Key refused" };
    case "connecting":
      return { tone: "neutral", text: "Connecting" };
    default:
      return { tone: "neutral", text: "Not connected" };
  }
}

/** Every provider, searchable, grouped as FrockBot, Popular, All and Your own. */
export function ProviderList(props: {
  providers: Provider[];
  current?: string | undefined;
  onChoose: (provider: Provider) => void;
  label: string;
}) {
  const [query, setQuery] = useState("");
  const found = matchProviders(props.providers, query);
  const groups = (["frockbot", "popular", "all"] as const)
    .map((group) => ({
      group,
      providers: found.filter((provider) => provider.group === group),
    }))
    .filter((group) => group.providers.length);
  return (
    <div class="picker">
      <label class="field">
        <span>{props.label}</span>
        <input
          type="search"
          value={query}
          placeholder="Search providers"
          autoFocus
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div class="picker-list" role="list">
        {groups.map(({ group, providers }) => (
          <div key={group} class="picker-group" role="presentation">
            <span class="navlabel">{GROUP_LABELS[group]}</span>
            {providers.map((provider) => {
              const state = stateWords(provider);
              return (
                <button
                  type="button"
                  role="listitem"
                  key={provider.packageId}
                  class={`picker-row${provider.packageId === props.current ? " on" : ""}`}
                  aria-current={
                    provider.packageId === props.current ? "true" : undefined
                  }
                  onClick={() => props.onChoose(provider)}
                >
                  <span class="grow stack-2">
                    <span class="row-title">{provider.name}</span>
                    {provider.description ? (
                      <span class="small clamp">{provider.description}</span>
                    ) : null}
                  </span>
                  <Pill tone={state.tone}>{state.text}</Pill>
                </button>
              );
            })}
          </div>
        ))}
        {!query.trim() ||
        "custom endpoint openai-compatible".includes(
          query.trim().toLowerCase(),
        ) ? (
          <div class="picker-group" role="presentation">
            <span class="navlabel">Your own</span>
            <div
              class="picker-row disabled"
              role="listitem"
              aria-disabled="true"
            >
              <span class="grow stack-2">
                <span class="row-title">
                  Custom endpoint (OpenAI-compatible)
                </span>
                <span class="small">
                  Any server that speaks the OpenAI API.
                </span>
              </span>
              <Soon />
            </div>
          </div>
        ) : null}
        {!groups.length && query.trim() ? (
          <p class="small pad">No provider matches “{query.trim()}”.</p>
        ) : null}
      </div>
    </div>
  );
}

function ModelPicker(props: { provider: Provider; onClose: () => void }) {
  const { data, reload } = useSetup();
  const action = useAction();
  const [query, setQuery] = useState("");
  const ready = props.provider.connections.filter((c) => c.state === "ready");
  const current = data.settings.accountModel;
  const needle = query.trim().toLowerCase();
  const choose = (connection: Connection, providerModelId: string) =>
    action.run(async () => {
      await setChatModel(data.settings.revision, {
        connectionId: connection.connectionId,
        providerModelId,
      });
      await reload();
      props.onClose();
    });
  return (
    <Dialog
      title={`Choose a ${props.provider.name} model for chat`}
      onClose={props.onClose}
      wide
    >
      <div class="picker">
        <label class="field">
          <span>Search models</span>
          <input
            type="search"
            value={query}
            autoFocus
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div class="picker-list" role="list">
          {ready.map((connection) => {
            const models = chatModels(connection).filter(
              (model) =>
                !needle ||
                `${model.displayName} ${model.providerModelId}`
                  .toLowerCase()
                  .includes(needle),
            );
            return (
              <div
                class="picker-group"
                key={connection.connectionId}
                role="presentation"
              >
                {ready.length > 1 ? (
                  <span class="navlabel">{connection.displayName}</span>
                ) : null}
                {!connection.modelCatalog?.models.length ? (
                  <p class="small pad">
                    {connection.modelCatalog?.state === "failed"
                      ? `${props.provider.name} didn’t list its models. Check the key in Your accounts.`
                      : `Reading ${props.provider.name}’s models…`}
                  </p>
                ) : null}
                {models.map((model) => {
                  const on =
                    current?.connectionId === connection.connectionId &&
                    current.providerModelId === model.providerModelId;
                  return (
                    <button
                      type="button"
                      role="listitem"
                      key={model.providerModelId}
                      class={`picker-row${on ? " on" : ""}`}
                      aria-current={on ? "true" : undefined}
                      disabled={action.busy}
                      onClick={() =>
                        void choose(connection, model.providerModelId)
                      }
                    >
                      <span class="grow stack-2">
                        <span class="row-title">{model.displayName}</span>
                        <span class="small">{model.providerModelId}</span>
                      </span>
                      {on ? <Pill tone="ok">In use</Pill> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <Problem message={action.problem} />
      </div>
    </Dialog>
  );
}

/**
 * Connects a provider with a key: adds it to the account when it isn't
 * there yet, stores the key, and waits for the provider to list its models.
 */
function ConnectProvider(props: {
  provider: Provider;
  onClose: () => void;
  onConnected: (provider: Provider) => void;
}) {
  const { data, reload } = useSetup();
  const action = useAction();
  const [key, setKey] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [needsFields, setNeedsFields] = useState(false);
  const fields = (props.provider.keyType?.settings ?? []).filter(
    (field) => field.kind !== "boolean",
  );
  const connect = () =>
    action.run(async () => {
      if (!key.trim()) throw new Error("Paste your key first.");
      let revision = data.settings.revision;
      let provider = props.provider;
      if (!provider.installed) {
        await addProvider(revision, provider.packageId);
        const fresh = await loadSetup();
        revision = fresh.settings.revision;
        provider =
          providersOf(fresh.settings, fresh.modelCatalog).find(
            (candidate) => candidate.packageId === provider.packageId,
          ) ?? provider;
        const required = (provider.keyType?.settings ?? []).filter(
          (field) => field.required && !values[field.id],
        );
        if (required.length) {
          setNeedsFields(true);
          await reload();
          throw new Error(
            `${provider.name} also needs ${listWords(required.map((f) => f.label.toLowerCase()))}.`,
          );
        }
      }
      if (!provider.keyType)
        throw new Error(`${provider.name} can’t be connected with a key yet.`);
      await connectKey(provider.keyType, provider.name, key.trim(), values);
      setKey("");
      // The provider lists its models once the key is stored; wait briefly
      // so the next step can offer them.
      let latest: SetupData | undefined;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        latest = await loadSetup();
        const connected = latest.settings.connections.find(
          (c) =>
            c.packageId === provider.packageId &&
            c.state === "ready" &&
            c.modelCatalog?.models.length,
        );
        const refused = latest.settings.connections.find(
          (c) => c.packageId === provider.packageId && c.state === "failed",
        );
        if (connected || refused) break;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await reload();
      const settled = latest
        ? providersOf(latest.settings, latest.modelCatalog).find(
            (candidate) => candidate.packageId === provider.packageId,
          )
        : undefined;
      if (settled?.state === "refused")
        throw new Error(
          `${provider.name} refused that key. Check it and try again.`,
        );
      props.onConnected(settled ?? provider);
    });
  return (
    <Dialog title={`Connect ${props.provider.name}`} onClose={props.onClose}>
      <form
        class="stack-16"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <p class="body muted">
          Your bots use your own {props.provider.name} account, and{" "}
          {props.provider.name} bills you for it. FrockBot never charges for it.
        </p>
        <Field
          label={`${props.provider.name} API key`}
          type="password"
          value={key}
          onInput={setKey}
          mono
          autoFocus
          hint="Keys are encrypted on the server and never shown again."
        />
        {(needsFields || props.provider.installed) &&
          fields.map((field) => (
            <Field
              key={field.id}
              label={field.required ? field.label : `${field.label} (optional)`}
              value={values[field.id] ?? ""}
              onInput={(value) => setValues({ ...values, [field.id]: value })}
              {...(field.hint ? { hint: field.hint } : {})}
            />
          ))}
        <Problem message={action.problem} />
        <div class="row-actions">
          <button type="button" class="btn outline" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={action.busy}>
            {action.busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReplaceKey(props: {
  connection: Connection;
  name: string;
  onClose: () => void;
}) {
  const { reload } = useSetup();
  const action = useAction();
  const [key, setKey] = useState("");
  return (
    <Dialog title={`Replace the ${props.name} key`} onClose={props.onClose}>
      <form
        class="stack-16"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            if (!key.trim()) throw new Error("Paste the new key first.");
            await replaceKey(props.connection.connectionId, key.trim());
            await reload();
            props.onClose();
          });
        }}
      >
        <Field
          label="New key"
          type="password"
          value={key}
          onInput={setKey}
          mono
          autoFocus
          hint="The old key stops being used as soon as this one is saved. Neither is ever shown."
        />
        <Problem message={action.problem} />
        <div class="row-actions">
          <button type="button" class="btn outline" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled={action.busy}>
            {action.busy ? "Saving…" : "Save key"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function JobRow(props: {
  job: Job;
  onProvider?: () => void;
  onModel?: () => void;
  imageChoice?: preact.ComponentChildren;
  open?: boolean;
}) {
  const { job } = props;
  const chooser = job.editable === "chat";
  return (
    <div class={`job${job.failure ? " failed" : ""}`}>
      <div class="job-name stack-2">
        <span class="row-title">{job.name}</span>
        <span class="small">{job.purpose}</span>
      </div>
      {chooser ? (
        <button
          type="button"
          class={`pick${props.open ? " open" : ""}`}
          aria-expanded={props.open ? "true" : "false"}
          aria-label={`Provider for ${job.name}: ${job.provider}`}
          onClick={props.onProvider}
        >
          <span class="clamp">{job.provider}</span>
          <Icon name="chevron" size={16} />
        </button>
      ) : (
        <span class={`pick static${job.follows ? " follow" : ""}`}>
          <span class="clamp">{job.provider}</span>
        </span>
      )}
      {chooser ? (
        <button
          type="button"
          class="pick"
          aria-label={`Model for ${job.name}: ${job.model}`}
          onClick={props.onModel}
        >
          <span class="clamp">{job.model}</span>
          <Icon name="chevron" size={16} />
        </button>
      ) : props.imageChoice ? (
        props.imageChoice
      ) : (
        <span class={`pick static${job.follows ? " follow" : ""}`}>
          <span class="clamp">{job.model}</span>
        </span>
      )}
      <div class="job-paid stack-4">
        <span class="small">{job.paidBy}</span>
        {job.failure ? <Pill tone="bad">Not working</Pill> : null}
        {job.comingSoon && !job.failure ? <Soon /> : null}
      </div>
    </div>
  );
}

export function AiPage() {
  const { data, reload, go } = useSetup();
  const providers = useMemo(
    () => providersOf(data.settings, data.modelCatalog),
    [data],
  );
  const chat = chatOf(data.settings, providers);
  const jobs = jobsOf(data.settings, providers, chat);
  const [mode, setMode] = useState<"frock" | "custom">(chat.mode);
  const [picking, setPicking] = useState(false);
  const [modelsOf, setModelsOf] = useState<Provider>();
  const [connecting, setConnecting] = useState<Provider>();
  const [replacing, setReplacing] = useState<Connection>();
  const [adding, setAdding] = useState(false);
  const switcher = useAction();
  const images = useAction();

  const chooseProvider = (provider: Provider) => {
    setPicking(false);
    setAdding(false);
    if (provider.packageId === FROCK_AI_PACKAGE_ID) {
      void switcher.run(async () => {
        await setChatModel(data.settings.revision, null);
        await reload();
      });
      return;
    }
    if (provider.state === "connected") setModelsOf(provider);
    else setConnecting(provider);
  };

  const own = providers.filter(
    (provider) =>
      provider.packageId !== FROCK_AI_PACKAGE_ID &&
      (provider.installed || provider.connections.length),
  );

  return (
    <>
      <PageHead
        title="AI"
        lede="Which model does each job, and whose account pays for it."
      >
        <Segmented
          label="Who runs AI"
          value={mode}
          options={[
            { value: "frock", label: "Frock AI" },
            { value: "custom", label: "Custom" },
          ]}
          onChange={(next) => {
            setMode(next);
            if (next === "frock" && chat.mode === "custom")
              void switcher.run(async () => {
                await setChatModel(data.settings.revision, null);
                await reload();
              });
          }}
        />
      </PageHead>
      <Problem message={switcher.problem} />

      {mode === "frock" ? (
        <section class="card pad-20 stack-12">
          <h2 class="h2">Frock AI does every job</h2>
          <p class="body muted">
            FrockBot picks a good model for each job and keeps it current. No
            keys, nothing to set up. It’s paid from your FrockBot credit.
          </p>
          <p class="body muted">
            Choose Custom to use your own OpenAI, Anthropic, Google or any other
            provider for chat.
          </p>
        </section>
      ) : (
        <>
          {chat.failure && chat.connection ? (
            <Notice
              tone="bad"
              title={`${providers.find((p) => p.packageId === chat.connection?.packageId)?.name ?? chat.connection.displayName} can’t answer chat`}
              action={
                chat.connection.authorization?.kind === "api-key" ? (
                  <button
                    type="button"
                    class="btn outline"
                    onClick={() => setReplacing(chat.connection)}
                  >
                    Update key
                  </button>
                ) : (
                  <button
                    type="button"
                    class="btn outline"
                    onClick={() => go("accounts")}
                  >
                    Fix in Your accounts
                  </button>
                )
              }
            >
              {chat.failure} Until it’s fixed your bots answer with Frock AI,
              from your credit. Update the key, or choose another provider for
              chat.
            </Notice>
          ) : null}

          <section class="card table" aria-label="Chat and jobs">
            <div class="table-head">
              <span>Chat and jobs</span>
              <span>Provider</span>
              <span>Model</span>
              <span>Paid by</span>
            </div>
            {jobs.chat.map((job) => (
              <div key={job.id}>
                <JobRow
                  job={job}
                  open={job.id === "chat" && picking}
                  onProvider={() => setPicking(!picking)}
                  onModel={() =>
                    chat.mode === "custom" && chat.provider
                      ? setModelsOf(chat.provider)
                      : setPicking(true)
                  }
                />
                {job.id === "chat" && picking ? (
                  <div class="inline-picker">
                    <ProviderList
                      label="Choose a provider for chat"
                      providers={providers}
                      current={chat.provider?.packageId}
                      onChoose={chooseProvider}
                    />
                  </div>
                ) : null}
              </div>
            ))}
            <p class="small table-foot">
              Writing, coding, thinking and vision follow chat. Choosing a
              different provider for each is coming soon.
            </p>
          </section>

          <section class="card table" aria-label="Jev, voice and images">
            <div class="table-head">
              <span>Jev, voice and images</span>
              <span>Provider</span>
              <span>Model</span>
              <span>Paid by</span>
            </div>
            {jobs.other.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                imageChoice={
                  job.editable === "images" ? (
                    <select
                      class="pick"
                      aria-label="Model for Images"
                      value={imageModelOf(data.settings)}
                      disabled={images.busy}
                      onChange={(event) => {
                        const model = event.currentTarget.value;
                        void images.run(async () => {
                          await setImageModel(data.settings.revision, model);
                          await reload();
                        });
                      }}
                    >
                      {IMAGE_MODELS.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  ) : undefined
                }
              />
            ))}
            <Problem message={images.problem} />
          </section>
        </>
      )}

      <section class="stack-12">
        <div class="section-head">
          <h2 class="h2">Your providers</h2>
          <button
            type="button"
            class="btn outline"
            onClick={() => setAdding(true)}
          >
            Add a provider
          </button>
        </div>
        {own.length ? (
          <div class="card rows">
            {own.map((provider) => {
              const state = stateWords(provider);
              const uses = [
                ...new Set(
                  provider.connections.flatMap((c) => usesOf(c, data.settings)),
                ),
              ];
              return (
                <div class="row" key={provider.packageId}>
                  <span class="grow stack-2">
                    <span class="row-title">{provider.name}</span>
                    <span class="small">
                      {uses.length ? listWords(uses) : "Not used yet"}
                    </span>
                  </span>
                  <Pill tone={state.tone}>{state.text}</Pill>
                  {provider.state === "not-connected" ? (
                    <button
                      type="button"
                      class="rowpill primary"
                      onClick={() => setConnecting(provider)}
                    >
                      Connect
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="rowpill"
                      onClick={() => go("accounts")}
                    >
                      Manage
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p class="body muted">
            None yet. Add one to use your own account for chat.
          </p>
        )}
      </section>

      {adding ? (
        <Dialog title="Add a provider" onClose={() => setAdding(false)} wide>
          <ProviderList
            label="Find a provider"
            providers={providers.filter(
              (p) => p.packageId !== FROCK_AI_PACKAGE_ID,
            )}
            onChoose={(provider) => {
              setAdding(false);
              if (provider.state === "connected") setModelsOf(provider);
              else setConnecting(provider);
            }}
          />
        </Dialog>
      ) : null}
      {connecting ? (
        <ConnectProvider
          provider={connecting}
          onClose={() => setConnecting(undefined)}
          onConnected={(provider) => {
            setConnecting(undefined);
            setMode("custom");
            setModelsOf(provider);
          }}
        />
      ) : null}
      {modelsOf ? (
        <ModelPicker
          provider={
            providers.find((p) => p.packageId === modelsOf.packageId) ??
            modelsOf
          }
          onClose={() => setModelsOf(undefined)}
        />
      ) : null}
      {replacing ? (
        <ReplaceKey
          connection={replacing}
          name={
            providers.find((p) => p.packageId === replacing.packageId)?.name ??
            replacing.displayName
          }
          onClose={() => setReplacing(undefined)}
        />
      ) : null}
    </>
  );
}
