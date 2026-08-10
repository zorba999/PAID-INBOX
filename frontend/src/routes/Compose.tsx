import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { INTENT_ACTIONS } from "@unicitylabs/sphere-sdk/connect";
import { api, ApiError, type PublicUser } from "../lib/api";
import { COIN } from "../lib/config";
import { classifyRequestError, describeConnectFailure } from "../lib/connectErrors";
import { durationFromMinutes, formatCoin, normalizeHandle, pct } from "../lib/format";
import { useWallet } from "../wallet/WalletProvider";
import { useSession } from "../app/SessionProvider";
import { Button, Label, useToast } from "../components/ui";
import { Page } from "../components/Shell";

type Step = "idle" | "creating" | "paying" | "confirming" | "messaging" | "done";

const STEP_COPY: Record<Exclude<Step, "idle" | "done">, string> = {
  creating: "Reserving the thread",
  paying: "Waiting for you to approve the transfer",
  confirming: "Recording the escrow",
  messaging: "Waiting for you to approve the message",
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function Compose() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const wallet = useWallet();
  const session = useSession();
  const toast = useToast();

  const [target, setTarget] = useState(params.get("to") ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipient, setRecipient] = useState<PublicUser | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stuckThread, setStuckThread] = useState<string | null>(null);

  /* ----------------------------------------------------------- lookup */

  const lookup = useCallback(async (raw: string) => {
    const handle = normalizeHandle(raw);
    if (!handle) {
      setRecipient(null);
      setLookupError(null);
      return;
    }
    try {
      const { user } = await api.profile(handle);
      setRecipient(user);
      setLookupError(user.isOpen ? null : "This inbox is closed right now.");
    } catch (err) {
      setRecipient(null);
      setLookupError(err instanceof ApiError ? err.message : "Could not find that inbox");
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void lookup(target), 320);
    return () => clearTimeout(id);
  }, [target, lookup]);

  /* ------------------------------------------------------------ send */

  const busy = step !== "idle" && step !== "done";

  // No escrow address means there is nowhere to pay. Say so here rather than
  // letting the user write a message and hit a 503 on submit.
  const escrowReady = session.config?.escrowConfigured !== false;

  const MIN_SUBJECT = 3;
  const MIN_BODY = 10;
  const isSelf = !!recipient && recipient.pubkey === session.me?.pubkey;

  /* A disabled button that will not say why is worse than no button. Every
   * condition that blocks the send names itself, in the order the user would
   * fix them. */
  const blocker: string | null = (() => {
    if (!target.trim()) return "Enter the handle of the inbox you want to reach.";
    if (!recipient) return "That handle did not resolve to an inbox.";
    if (isSelf) return "That is your own inbox.";
    if (!recipient.isOpen) return "This inbox is closed to new messages.";
    if (!escrowReady) return "This server has no escrow address configured.";
    if (subject.trim().length < MIN_SUBJECT)
      return `The subject needs at least ${MIN_SUBJECT} characters.`;
    if (body.trim().length < MIN_BODY)
      return `The message needs at least ${MIN_BODY} characters — you have ${body.trim().length}.`;
    if (wallet.isWalletLocked) return "Unlock your wallet to approve the payment.";
    return null;
  })();

  const canSend = !blocker && !busy;

  const send = useCallback(async () => {
    if (!recipient) return;
    setError(null);
    setStuckThread(null);

    let threadId: string | null = null;

    try {
      /* 1 — reserve the thread and get the payment instructions */
      setStep("creating");
      const created = await api.createThread({
        to: recipient.handle ?? recipient.pubkey,
        subject: subject.trim(),
      });
      threadId = created.thread.id;

      /* 2 — fund the escrow. The wallet asks the user; we never see a key. */
      setStep("paying");
      const paid = await wallet.intent<{
        success: boolean;
        transferId?: string;
        status: string;
        deliveryPending: boolean;
      }>(INTENT_ACTIONS.SEND, {
        to: created.payment.to,
        amount: created.payment.amount,
        coinId: created.payment.coinId,
        memo: created.payment.memo,
      });

      /* deliveryPending true means the spend IS committed and delivery retries
       * on its own. Treat the money as sent; never re-issue. */
      setStep("confirming");
      await api.markPaid(threadId, {
        transferId: paid.transferId ?? null,
        deliveryPending: !!paid.deliveryPending,
      });

      if (paid.deliveryPending) {
        toast.push({
          tone: "warn",
          title: "Escrow committed, delivery still settling",
          body: "The spend is on-chain. The recipient side retries on its own — do not send again.",
        });
      }

      /* 3 — the message itself, wallet to wallet, encrypted. Our backend gets
       * an id and a hash, never the body. */
      setStep("messaging");
      const dmTo = recipient.handle ? `@${recipient.handle}` : recipient.pubkey;
      const dm = await wallet.intent<{ sent: boolean; messageId: string; timestamp: number }>(
        INTENT_ACTIONS.DM,
        { to: dmTo, message: `${subject.trim()}\n\n${body.trim()}` },
      );

      await api.markDelivered(threadId, {
        messageId: dm.messageId,
        timestamp: dm.timestamp,
        bodyHash: await sha256Hex(body.trim()),
      });

      setStep("done");
      toast.push({
        tone: "ok",
        title: "Sent",
        body: `${formatCoin(recipient.priceBase)} is held in escrow until ${
          recipient.handle ? `@${recipient.handle}` : "they"
        } replies or the window closes.`,
      });
      navigate(`/t/${threadId}`);
    } catch (err) {
      const kind = classifyRequestError(err);

      if (kind === "outcome-unknown" && threadId) {
        // 4201. The single case where re-enabling the button is the wrong move.
        await api.markReconcile(threadId, "intent outcome unknown (4201)").catch(() => {});
        setStuckThread(threadId);
        setError(
          "The wallet took the payment and the answer was lost. The money may or may not have moved — we are reconciling this thread. Do not send it again.",
        );
      } else {
        setError(err instanceof ApiError ? err.message : describeConnectFailure(err));
      }
      setStep("idle");
    }
  }, [recipient, subject, body, wallet, navigate, toast]);

  /* ------------------------------------------------------------- view */

  const cost = useMemo(() => (recipient ? formatCoin(recipient.priceBase) : "—"), [recipient]);

  return (
    <Page eyebrow="compose" title="Send a paid message">
      {!escrowReady && (
        <div className="notice notice--warn">
          <Label tone="accent">escrow not configured</Label>
          <p>
            This server has no escrow address, so there is nowhere for the payment to go. Set{" "}
            <span className="mono">ESCROW_ADDRESS</span> to a registered nametag (or run{" "}
            <span className="mono">PAYOUT_MODE=sphere</span> so the escrow wallet supplies its own) and
            restart the API.
          </p>
        </div>
      )}

      <div className="compose">
        <section className="compose__form">
          <label className="field">
            <div className="field__label">
              <Label tone="strong">recipient</Label>
              {recipient && <Label tone="accent">found</Label>}
            </div>
            <input
              className="input input--mono"
              placeholder="@handle"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            {lookupError && <p className="field__err">{lookupError}</p>}
            {isSelf && <p className="field__err">That is your own inbox.</p>}
          </label>

          <label className="field">
            <div className="field__label">
              <Label tone="strong">subject</Label>
              <span className={`num ${subject.trim().length < MIN_SUBJECT ? "accent" : "dim"}`}>
                {subject.length}/140
              </span>
            </div>
            <input
              className="input"
              placeholder="Say what this is about in one line"
              value={subject}
              maxLength={140}
              onChange={(e) => setSubject(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="field">
            <div className="field__label">
              <Label tone="strong">message</Label>
              <span className={`num ${body.trim().length < MIN_BODY ? "accent" : "dim"}`}>
                {body.trim().length < MIN_BODY ? `${body.trim().length} / ${MIN_BODY} min` : body.length}
              </span>
            </div>
            <textarea
              className="textarea"
              placeholder="Encrypted end to end. It goes straight from your wallet to theirs — this app never sees it."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
            />
          </label>

          {error && (
            <div className={`notice ${stuckThread ? "notice--danger" : "notice--warn"}`}>
              <Label tone="accent">{stuckThread ? "do not retry" : "not sent"}</Label>
              <p>{error}</p>
              {stuckThread && (
                <Button size="sm" variant="ghost" onClick={() => navigate(`/t/${stuckThread}`)}>
                  Open the thread
                </Button>
              )}
            </div>
          )}

          <div className="compose__actions">
            <Button variant="primary" size="lg" onClick={send} disabled={!canSend} loading={busy}>
              {busy ? STEP_COPY[step as Exclude<Step, "idle" | "done">] : `Pay ${cost} and send`}
            </Button>
            {!busy && blocker && <p className="compose__blocker">{blocker}</p>}
          </div>

          <ol className="flow" aria-label="What happens next">
            <FlowItem n={1} active={step === "paying"} done={["confirming", "messaging", "done"].includes(step)}>
              Approve the transfer into escrow
            </FlowItem>
            <FlowItem n={2} active={step === "messaging"} done={step === "done"}>
              Approve the encrypted message
            </FlowItem>
            <FlowItem n={3} active={false} done={step === "done"}>
              Wait for the reply, or the refund
            </FlowItem>
          </ol>
          <p className="dim compose__hint">
            Two approvals, on purpose: the payment and the message are separate acts, and keeping them apart is
            what lets the message stay end-to-end encrypted.
          </p>
        </section>

        {/* ----------------------------------------------------- receipt */}
        <aside className="compose__aside">
          <div className="receipt card card--pad">
            <Label tone="accent">receipt</Label>

            {recipient ? (
              <>
                <div className="receipt__to mono">@{recipient.handle ?? "anon"}</div>
                {recipient.bio && <p className="muted receipt__bio">{recipient.bio}</p>}

                <hr className="rule" />

                <Row k="price" v={cost} big />
                <Row k="reply window" v={`${recipient.replyWindowHours}h`} />
                <Row
                  k="reply rate"
                  v={recipient.stats.replyRate === null ? "no history" : pct(recipient.stats.replyRate)}
                />
                <Row k="median reply" v={durationFromMinutes(recipient.stats.medianReplyMinutes)} />
                <Row k="answered" v={`${recipient.stats.answered} / ${recipient.stats.received}`} />

                <hr className="rule" />

                <div className="receipt__deal">
                  <Label>if they reply</Label>
                  <p>
                    {session.config?.payoutPolicy === "silence" ? (
                      <>
                        You get <b className="num">{cost}</b> back.
                      </>
                    ) : (
                      <>
                        They keep <b className="num">{cost}</b> minus the{" "}
                        {session.config ? session.config.feeBps / 100 : 5}% fee.
                      </>
                    )}
                  </p>
                  <Label>if they stay silent</Label>
                  <p>
                    {session.config?.payoutPolicy === "silence" ? (
                      <>
                        They keep <b className="num">{cost}</b>.
                      </>
                    ) : (
                      <>
                        You get all <b className="num">{cost}</b> back after {recipient.replyWindowHours}h.
                      </>
                    )}
                  </p>
                </div>

                <hr className="rule" />
                <Row k="coin" v={COIN.symbol} />
                <Row k="escrow" v={session.config?.escrowAddress ?? "—"} />
              </>
            ) : (
              <p className="muted receipt__empty">
                Type a handle to see what it costs to reach them and how often they actually answer.
              </p>
            )}
          </div>
        </aside>
      </div>
    </Page>
  );
}

function Row({ k, v, big = false }: { k: string; v: string; big?: boolean }) {
  return (
    <div className="receipt__row">
      <Label>{k}</Label>
      <span className={`mono ${big ? "receipt__big accent" : ""}`}>{v}</span>
    </div>
  );
}

function FlowItem({
  n,
  active,
  done,
  children,
}: {
  n: number;
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={`flow__item ${active ? "flow__item--on" : ""} ${done ? "flow__item--done" : ""}`}>
      <span className="flow__n num">{done ? "✓" : n}</span>
      <span>{children}</span>
    </li>
  );
}
