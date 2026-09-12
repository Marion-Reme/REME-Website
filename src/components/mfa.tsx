/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { createClient } from "@/lib/supabase/client";

async function prepareEnrolment() {
  const supabase = createClient();
  const factors = await supabase.auth.mfa.listFactors();
  if (factors.error) throw factors.error;
  if (factors.data.totp.some((factor) => factor.status === "verified")) return null;

  // Unfinished enrolments cannot return their secret again. Replace only this
  // app's unverified factors; never remove a working authenticator.
  for (const factor of factors.data.all) {
    if (
      factor.factor_type === "totp" &&
      factor.status === "unverified" &&
      factor.friendly_name === "REME manager"
    ) {
      const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (removed.error) throw removed.error;
    }
  }
  const result = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "REME manager",
  });
  if (result.error) throw result.error;
  if (!result.data.id || !result.data.totp.qr_code || !result.data.totp.secret)
    throw new Error("Authenticator setup was incomplete. Please try again.");
  return result.data;
}

export function MfaEnrol() {
  const [factorId, setFactorId] = useState("");
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const router = useRouter();

  const preparation = useRef<ReturnType<typeof prepareEnrolment> | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    // Share the request across React Strict Mode's effect replay.
    preparation.current ??= prepareEnrolment();
    void preparation.current
      .then((data) => {
        if (!active) return;
        if (!data) {
          router.replace("/mfa");
          return;
        }
        setFactorId(data.id);
        const qrCode = data.totp.qr_code;
        setQr(
          qrCode.trimStart().startsWith("<svg")
            ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrCode)}`
            : qrCode,
        );
        setSecret(data.totp.secret);
        setBusy(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to prepare your authenticator. Please try again.",
        );
        setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, router]);

  const verify = async () => {
    if (busy || !factorId || code.length !== 6) return;
    setBusy(true);
    setError("");
    const supabase = createClient();
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) {
      setError(challenge.error.message);
      setBusy(false);
      return;
    }
    const result = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code,
    });
    if (result.error) {
      setError("That code was not accepted. Check the time on your phone and try again.");
      setBusy(false);
      return;
    }
    const saved = await supabase.rpc("set_mfa_enrolled", { p_enrolled: true });
    if (saved.error) {
      setError(saved.error.message);
      setBusy(false);
      return;
    }
    router.replace("/manager");
    router.refresh();
  };

  if (busy && !qr)
    return (
      <div className="flex items-center gap-2 text-sm text-[#65716d]">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Preparing authenticator...
      </div>
    );
  if (!factorId || !secret || !qr)
    return (
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-xl bg-[#f5dfdc] p-3 text-sm text-[#913a31]">
            {error}
          </p>
        )}
        <Button
          className="w-full"
          onClick={() => {
            preparation.current = null;
            setError("");
            setBusy(true);
            setAttempt((value) => value + 1);
          }}
        >
          Retry authenticator setup
        </Button>
      </div>
    );
  return (
    <div className="space-y-5">
      {qr && (
        <div className="flex justify-center rounded-2xl bg-white p-4">
          <img src={qr} alt="Authenticator QR code" className="h-52 w-52" />
        </div>
      )}
      <div>
        <Label>Manual setup key</Label>
        <code className="block rounded-xl bg-[#f1efe9] p-3 text-xs break-all">{secret}</code>
      </div>
      <div>
        <Label htmlFor="code">Six-digit code</Label>
        <Input
          id="code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
        />
      </div>
      {error && <p className="rounded-xl bg-[#f5dfdc] p-3 text-sm text-[#913a31]">{error}</p>}
      <Button className="w-full" onClick={() => void verify()} disabled={busy || code.length !== 6}>
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        Verify and continue
      </Button>
    </div>
  );
}

export function MfaChallenge() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let active = true;
    void createClient()
      .auth.mfa.listFactors()
      .then(({ data, error: factorError }) => {
        if (!active) return;
        if (factorError) {
          setError(factorError.message);
        } else if (!data.totp.some((factor) => factor.status === "verified")) {
          router.replace("/security/mfa-enrol");
          return;
        }
        setBusy(false);
      })
      .catch(() => {
        if (!active) return;
        setError("Unable to check your authenticator. Please try again.");
        setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  const verify = async () => {
    setBusy(true);
    setError("");
    const supabase = createClient();
    const factors = await supabase.auth.mfa.listFactors();
    if (factors.error) {
      setError(factors.error.message);
      setBusy(false);
      return;
    }
    const factor = factors.data?.totp.find((item) => item.status === "verified");
    if (!factor) {
      router.replace("/security/mfa-enrol");
      return;
    }
    const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id });
    if (challenge.error) {
      setError(challenge.error.message);
      setBusy(false);
      return;
    }
    const result = await supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.data.id,
      code,
    });
    if (result.error) {
      setError("Incorrect code. Try the current code from your authenticator.");
      setBusy(false);
      return;
    }
    const saved = await supabase.rpc("set_mfa_enrolled", { p_enrolled: true });
    if (saved.error) {
      setError(saved.error.message);
      setBusy(false);
      return;
    }
    router.replace("/manager");
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#e2f1f8] text-[#0077a8]">
        <KeyRound className="h-6 w-6" />
      </div>
      <div>
        <Label htmlFor="mfa-code">Authenticator code</Label>
        <Input
          id="mfa-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoFocus
          autoComplete="one-time-code"
          placeholder="000000"
        />
      </div>
      {error && <p className="rounded-xl bg-[#f5dfdc] p-3 text-sm text-[#913a31]">{error}</p>}
      <Button className="w-full" onClick={() => void verify()} disabled={busy || code.length !== 6}>
        {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}Continue
      </Button>
    </div>
  );
}
