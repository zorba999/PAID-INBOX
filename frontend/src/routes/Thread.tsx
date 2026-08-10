import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { INTENT_ACTIONS, RPC_METHODS } from "@unicitylabs/sphere-sdk/connect";
import { api, ApiError, type Thread as ThreadT, type ThreadEvent } from "../lib/api";
import { classifyRequestError, describeConnectFailure } from "../lib/connectErrors";
import { absoluteTime, formatCoin, relativeTime, shortKey } from "../lib/format";
import { useWallet } from "../wallet/WalletProvider";
import { useSession } from "../app/SessionProvider";
import { demoPeerKey } from "../wallet/demoHost";
import { Button, Countdown, Label, Spinner, useToast } from "../components/ui";
import { Page } from "../components/Shell";
import { StateChip } from "../components/StateChip";

interface WalletMessage {
  id: string;
  body?: string;
  content?: string;
  fromMe?: boolean;
  at?: number;
  timestamp?: number;
}

export function ThreadView() {
  const { id = "" } = useParams();
  const wallet = useWallet();
  const session = useSession();
  const toast = useToast();

  const [thread, setThread] = useState<ThreadT | null>(null);
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [messages, setMessages] = useState<WalletMessage[] | null>(null);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");

  const minChars = session.config?.minReplyChars ?? 80;

  /* ------------------------------------------------------------- load */

  const load = useCallback(async () => {
    try {
      const res = await api.thread(id);
      setThread(res.thread);
      setEvents(res.events);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this thread");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /* The thread body lives in the wallet, not on our server. We read it through
   * `dm:read` — and we stop reading entirely while the wallet is locked, because
   * every refusal bumps the wallet's blocked-request badge. */
  const counterparty = thread ? (thread.role === "sender" ? thread.recipient : thread.sender) : null;

  const peerKey = counterparty
    ? wallet.isDemo
      ? demoPeerKey(counterparty.handle ?? counterparty.pubkey)
      : counterparty.pubkey
    : null;

  useEffect(() => {
    if (!peerKey || !wallet.isConnected || wallet.isWalletLocked) return;
    let alive = true;

    void (async () => {
      try {
        const res = await wallet.query<WalletMessage[]>(RPC_METHODS.GET_MESSAGES, {
          peerPubkey: peerKey,
          limit: 50,
        });
        if (alive) {
          setMessages(Array.isArray(res) ? res : []);
          setMsgError(null);
        }
      } catch (err) {
        if (alive) setMsgError(describeConnectFailure(err));
      }
    })();

    return () => {
      alive = false;
    };
    // unlockEpoch is the resume signal after a lock
  }, [peerKey, wallet.isConnected, wallet.isWalletLocked, wallet.unlockEpoch, wallet]);

  /* ------------------------------------------------------------ reply */

  const submitReply = useCallback(async () => {
    if (!thread || !counterparty) return;
    setSending(true);
    setError(null);

    try {
      /* 1 — the reply itself, wallet to wallet. */
      const dmTo = counterparty.handle ? `@${counterparty.handle}` : counterparty.pubkey;
      const dm = await wallet.intent<{ sent: boolean; messageId: string; timestamp: number }>(
        INTENT_ACTIONS.DM,
        { to: dmTo, message: reply.trim() },
      );

      /* 2 — a signed attestation. This is how the server learns a reply
       * happened without ever being able to read one. */
      const challenge = await api.replyChallenge(thread.id, {
        messageId: dm.messageId,
        timestamp: dm.timestamp,
      });

      const signed = await wallet.intent<{ signature: string; publicKey: string }>(
        INTENT_ACTIONS.SIGN_MESSAGE,
        { message: challenge.message },
      );

      const res = await api.submitReply(thread.id, {
        nonce: challenge.nonce,
        signature: signed.signature,
        replyLength: reply.trim().length,
      });

      setThread(res.thread);
      setReply("");
      await load();
      toast.push({
        tone: "ok",
        title: "Reply attested",
        body: `The escrow releases to you in ${session.config?.disputeWindowHours ?? 24}h unless the sender disputes.`,
      });
    } catch (err) {
      const kind = classifyRequestError(err);
      if (kind === "outcome-unknown") {
        setError(
          "The wallet lost track of the reply. Reload the thread before trying again — it may already be recorded.",
        );
      } else {
        setError(err instanceof ApiError ? err.message : describeConnectFailure(err));
      }
    } finally {
      setSending(false);
    }
  }, [thread, counterparty, wallet, reply, load, toast, session.config]);

  const submitDispute = useCallback(async () => {
    if (!thread) return;
    try {
      const res = await api.dispute(thread.id, disputeReason);
      setThread(res.thread);
      setDisputing(false);
      await load();
      toast.push({ tone: "warn", title: "Disputed", body: "Settlement is frozen pending review." });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not file the dispute");
    }
  }, [thread, disputeReason, load, toast]);

  /* ------------------------------------------------------------- view */

  if (loading) {
    return (
      <Page eyebrow="thread" title="Loading">
        <Spinner label="reading thread" />
      </Page>
    );
  }

  if (!thread) {
    return (
      <Page eyebrow="thread" title="Not found">
        <p className="muted">{error ?? "This thread does not exist, or it is not yours."}</p>
        <Link to="/inbox" className="btn btn--ghost">
          Back to inbox
        </Link>
      </Page>
    );
  }

  const iAmRecipient = thread.role === "recipient";
  const canReply = iAmRecipient && thread.state === "DELIVERED" && !wallet.isWalletLocked;
  const canDispute =
    !iAmRecipient && thread.state === "REPLIED" && !!thread.confirmUntil && thread.confirmUntil > Date.now();

  return (
    <Page
      eyebrow={`thread · ${thread.ref}`}
      title={thread.subject}
      actions={<StateChip state={thread.state} />}
    >
      <div className="thread">
        <section className="thread__main">
          {/* -------------------------------------------------- deal */}
          <div className="deal-strip card card--pad">
            <div className="deal-strip__amount">
              <Label tone="accent">in escrow</Label>
              <div className="deal-strip__v num">{formatCoin(thread.priceBase)}</div>
            </div>
            <div className="deal-strip__rules">
              <div>
                <Label>if replied</Label>
                <p className="mono">
                  → {thread.outcomeIfReplied === "recipient" ? "recipient" : "sender"}{" "}
                  {thread.outcomeIfReplied === "recipient" && (
                    <span className="dim">({formatCoin(thread.netBase)} after fee)</span>
                  )}
                </p>
              </div>
              <div>
                <Label>if silent</Label>
                <p className="mono">→ {thread.outcomeIfSilent === "recipient" ? "recipient" : "sender"}</p>
              </div>
              <div>
                <Label>{thread.state === "REPLIED" ? "releases in" : "window closes"}</Label>
                <p className="mono">
                  {thread.state === "REPLIED" ? (
                    <Countdown to={thread.confirmUntil} />
                  ) : (
                    <Countdown to={thread.deadlineAt} />
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* ---------------------------------------------- messages */}
          <div className="msgs">
            <div className="row row--between">
              <Label tone="strong">conversation</Label>
              <Label>read from your wallet · dm:read</Label>
            </div>

            {wallet.isWalletLocked ? (
              <p className="muted msgs__note">
                Paused while the wallet is locked. Nothing is cached here — the messages live in Sphere.
              </p>
            ) : msgError ? (
              <p className="muted msgs__note">{msgError}</p>
            ) : messages === null ? (
              <Spinner label="decrypting" />
            ) : messages.length === 0 ? (
              <p className="muted msgs__note">
                No messages in this conversation yet, or your wallet has not synced them.
              </p>
            ) : (
              <ul className="msgs__list">
                {messages.map((m) => (
                  <li key={m.id} className={`msg ${m.fromMe ? "msg--mine" : ""}`}>
                    <div className="msg__meta">
                      <Label bare>{m.fromMe ? "you" : counterparty?.handle ? `@${counterparty.handle}` : "them"}</Label>
                      <span className="dim num">{relativeTime(m.at ?? m.timestamp ?? Date.now())}</span>
                    </div>
                    <p className="msg__body">{m.body ?? m.content ?? ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ------------------------------------------------- reply */}
          {canReply && (
            <div className="replybox card card--pad">
              <div className="row row--between">
                <Label tone="accent">reply and release the escrow</Label>
                <span className={`num ${reply.trim().length < minChars ? "dim" : "accent"}`}>
                  {reply.trim().length} / {minChars}
                </span>
              </div>

              <textarea
                className="textarea"
                placeholder="A real answer. Anything shorter than the minimum will not release the escrow."
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                disabled={sending}
              />

              <div className="row row--between replybox__foot">
                <p className="dim">
                  Two approvals: the message, then a signature proving you sent it.
                </p>
                <Button
                  variant="primary"
                  onClick={submitReply}
                  loading={sending}
                  disabled={reply.trim().length < minChars}
                >
                  Reply & earn {formatCoin(thread.netBase)}
                </Button>
              </div>
            </div>
          )}

          {iAmRecipient && thread.state === "REPLIED" && (
            <div className="notice notice--ok">
              <Label tone="accent">attested</Label>
              <p>
                Your reply is recorded. The escrow releases automatically when the dispute window closes —{" "}
                <Countdown to={thread.confirmUntil} />.
              </p>
            </div>
          )}

          {canDispute && (
            <div className="notice notice--warn">
              <Label tone="accent">not a real answer?</Label>
              <p>
                You have <Countdown to={thread.confirmUntil} /> to dispute before the escrow releases.
              </p>
              {disputing ? (
                <>
                  <textarea
                    className="textarea"
                    placeholder="What was wrong with the reply?"
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                  />
                  <div className="row">
                    <Button variant="danger" size="sm" onClick={submitDispute}>
                      File dispute
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDisputing(false)}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setDisputing(true)}>
                  Dispute this reply
                </Button>
              )}
            </div>
          )}

          {thread.state === "PENDING_RECONCILE" && (
            <div className="notice notice--danger">
              <Label tone="accent">reconciling</Label>
              <p>
                The wallet took the payment and the answer was lost (error 4201). We are checking whether the
                money moved. Do not send this message again — a retry would pay twice.
              </p>
            </div>
          )}

          {error && (
            <div className="notice notice--warn">
              <Label tone="accent">error</Label>
              <p>{error}</p>
            </div>
          )}
        </section>

        {/* ------------------------------------------------- audit trail */}
        <aside className="thread__side">
          <div className="card card--pad">
            <Label tone="accent">audit trail</Label>
            <ol className="trail">
              {events.map((e, i) => (
                <li key={i} className="trail__item">
                  <span className="trail__dot" aria-hidden />
                  <div>
                    <span className="mono trail__type">{e.type}</span>
                    <div className="dim num trail__at">{absoluteTime(e.at)}</div>
                  </div>
                </li>
              ))}
            </ol>

            <hr className="rule" />

            <Meta k="ref" v={thread.ref} />
            <Meta k="counterparty" v={counterparty?.handle ? `@${counterparty.handle}` : shortKey(counterparty?.pubkey)} />
            <Meta k="transfer" v={thread.transferId ? shortKey(thread.transferId, 8, 6) : "—"} />
            <Meta k="message id" v={thread.messageId ? shortKey(thread.messageId, 8, 6) : "—"} />
            <Meta k="reply id" v={thread.replyMessageId ? shortKey(thread.replyMessageId, 8, 6) : "—"} />
            <Meta k="fee" v={formatCoin(thread.feeBase)} />
            <Meta k="policy" v={thread.payoutPolicy} />
            {thread.deliveryPending && <Meta k="delivery" v="retrying" />}
          </div>
        </aside>
      </div>
    </Page>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="meta__row">
      <Label>{k}</Label>
      <span className="mono">{v}</span>
    </div>
  );
}
