// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaChallenge, MfaEnrol } from "@/components/mfa";

const mocks = vi.hoisted(() => ({
  listFactors: vi.fn(),
  unenroll: vi.fn(),
  enroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
  rpc: vi.fn(),
  router: { replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { mfa: mocks },
    rpc: mocks.rpc,
  }),
}));
const pending = {
  id: "unfinished",
  factor_type: "totp",
  status: "unverified",
  friendly_name: "REME manager",
};
const verified = { ...pending, id: "working", status: "verified" };
const setup = {
  id: "fresh",
  totp: { qr_code: "data:image/svg+xml;utf-8,test", secret: "TEST-SETUP-KEY" },
};
const factors = (all: (typeof pending)[]) => ({
  data: { all, totp: all.filter((f) => f.status === "verified") },
  error: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listFactors.mockResolvedValue(factors([]));
  mocks.unenroll.mockResolvedValue({ error: null });
  mocks.enroll.mockResolvedValue({ data: setup, error: null });
  mocks.challenge.mockResolvedValue({ data: { id: "challenge" }, error: null });
  mocks.verify.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ error: null });
});
afterEach(cleanup);

describe("MFA re-enrolment", () => {
  it("replaces unfinished REME factors and displays the new QR and key once in Strict Mode", async () => {
    mocks.listFactors.mockResolvedValue(
      factors([pending, { ...pending, id: "other", friendly_name: "Another app" }]),
    );
    render(createElement(StrictMode, null, createElement(MfaEnrol)));
    await screen.findByText(setup.totp.secret);
    expect(mocks.enroll).toHaveBeenCalledTimes(1);
    expect(mocks.unenroll).toHaveBeenCalledExactlyOnceWith({ factorId: pending.id });
    expect(mocks.unenroll.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enroll.mock.invocationCallOrder[0],
    );
    expect(screen.getByAltText("Authenticator QR code").getAttribute("src")).toBe(
      setup.totp.qr_code,
    );
  });

  it("preserves verified authenticators and redirects to verification", async () => {
    mocks.listFactors.mockResolvedValue(factors([pending, verified]));
    render(createElement(MfaEnrol));
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/mfa"));
    expect(mocks.unenroll).not.toHaveBeenCalled();
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it("shows a retry instead of blank setup fields when enrolment fails", async () => {
    mocks.enroll.mockResolvedValueOnce({ data: null, error: new Error("Setup failed") });
    render(createElement(MfaEnrol));
    await screen.findByRole("alert");
    expect(screen.queryByText("Manual setup key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify and continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry authenticator setup" }));
    await screen.findByText(setup.totp.secret);
    expect(mocks.enroll).toHaveBeenCalledTimes(2);
  });

  it("stops when removing an unfinished factor fails", async () => {
    mocks.listFactors.mockResolvedValue(factors([pending]));
    mocks.unenroll.mockResolvedValue({ error: new Error("Removal failed") });
    render(createElement(MfaEnrol));
    await screen.findByText("Removal failed");
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it("turns a raw SVG response into an image URL", async () => {
    mocks.enroll.mockResolvedValue({
      data: {
        ...setup,
        totp: { ...setup.totp, qr_code: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      },
      error: null,
    });
    render(createElement(MfaEnrol));
    const image = await screen.findByAltText("Authenticator QR code");
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  });

  it("only saves enrolment after successfully verifying the code", async () => {
    render(createElement(MfaEnrol));
    await screen.findByText(setup.totp.secret);
    mocks.verify.mockResolvedValueOnce({ error: new Error("Invalid code") });
    fireEvent.change(screen.getByLabelText("Six-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    await screen.findByText(/That code was not accepted/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/manager"));
    expect(mocks.challenge).toHaveBeenCalledWith({ factorId: "fresh" });
    expect(mocks.rpc).toHaveBeenCalledWith("set_mfa_enrolled", { p_enrolled: true });
  });

  it("automatically returns accounts with removed factors to setup", async () => {
    render(createElement(MfaChallenge));
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/security/mfa-enrol"));
    expect(mocks.challenge).not.toHaveBeenCalled();
  });

  it("does not mistake a factor lookup error for a removed authenticator", async () => {
    mocks.listFactors.mockResolvedValue({ data: null, error: new Error("Connection failed") });
    render(createElement(MfaChallenge));
    await screen.findByText("Connection failed");
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it("does not enrol or remove factors when the setup lookup fails", async () => {
    mocks.listFactors.mockResolvedValue({ data: null, error: new Error("Lookup failed") });
    render(createElement(MfaEnrol));
    await screen.findByRole("alert");
    expect(mocks.unenroll).not.toHaveBeenCalled();
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it("offers retry when the setup response has no manual key", async () => {
    mocks.enroll.mockResolvedValue({
      data: { ...setup, totp: { ...setup.totp, secret: "" } },
      error: null,
    });
    render(createElement(MfaEnrol));
    await screen.findByRole("button", { name: "Retry authenticator setup" });
    expect(screen.queryByText("Manual setup key")).toBeNull();
  });

  it("saves the challenge enrolment flag only after a valid code", async () => {
    mocks.listFactors.mockResolvedValue(factors([verified]));
    mocks.verify.mockResolvedValueOnce({ error: new Error("Invalid code") });
    render(createElement(MfaChallenge));
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    const button = screen.getByRole("button", { name: "Continue" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Incorrect code/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.router.replace).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/manager"));
    expect(mocks.challenge).toHaveBeenCalledWith({ factorId: verified.id });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("set_mfa_enrolled", { p_enrolled: true });
    expect(mocks.verify.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.rpc.mock.invocationCallOrder[0],
    );
  });

  it("stays on the challenge screen if saving enrolment fails", async () => {
    mocks.listFactors.mockResolvedValue(factors([verified]));
    mocks.rpc.mockResolvedValue({ error: new Error("Save failed") });
    render(createElement(MfaChallenge));
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    const button = screen.getByRole("button", { name: "Continue" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByText("Save failed");
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  });
});
