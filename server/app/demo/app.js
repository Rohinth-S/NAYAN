"use strict";

const form = document.querySelector("#enrollment");
const consent = document.querySelector("#consent");
const status = document.querySelector("#status");
const password = document.querySelector("#account-password");
const reveal = document.querySelector(".reveal");
const submit = document.querySelector("#submit-enrollment");
const submitOrb = document.querySelector("#submitOrb");
const formStatusOrb = document.querySelector("#formStatusOrb");
const heroOrb = document.querySelector("#heroOrb");

reveal?.addEventListener("click", () => {
  const isVisible = password.type === "text";
  password.type = isVisible ? "password" : "text";
  reveal.textContent = isVisible ? "Show" : "Hide";
  reveal.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
});

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    if (!form.reportValidity()) {
      status.textContent = "Complete the required transfer details before submitting.";
      status.dataset.error = "true";
      if (formStatusOrb) formStatusOrb.state = "shaping";
      return;
    }
    if (!consent.checked) {
      status.textContent = "Select the confirmation checkbox before submitting.";
      status.dataset.error = "true";
      if (formStatusOrb) formStatusOrb.state = "shaping";
      return;
    }

    submit.disabled = true;
    if (submitOrb) {
      submitOrb.removeAttribute("paused");
      submitOrb.state = "working";
    }
    if (formStatusOrb) formStatusOrb.state = "connecting";
    if (heroOrb) heroOrb.state = "connecting";

    status.textContent = "Submitting…";
    delete status.dataset.error;
    try {
      const response = await fetch("/demo/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      if (!response.ok) throw new Error("submission failed");
      const result = await response.json();
      if (result.submitted !== true) throw new Error("submission was not confirmed");

      status.textContent = "Transfer request submitted successfully.";
      delete status.dataset.error;
      if (formStatusOrb) formStatusOrb.state = "solving";
      if (heroOrb) heroOrb.state = "solving";
      document.body.dataset.demoComplete = "true";
      window.location.assign("/demo/success");
    } catch {
      status.textContent = "Submission failed. Try again.";
      status.dataset.error = "true";
      submit.disabled = false;
      if (formStatusOrb) formStatusOrb.state = "shaping";
      if (heroOrb) heroOrb.state = "searching";
      if (submitOrb) submitOrb.setAttribute("paused", "");
    }
  });
}

// Thinking Orbs Interactive Showcase
const telemetryOrb = document.querySelector("#telemetryOrb");
const telemetryBadge = document.querySelector("#telemetryBadge");
const telemetryModeTag = document.querySelector("#telemetryModeTag");
const telemetryTitle = document.querySelector("#telemetryTitle");
const telemetryDesc = document.querySelector("#telemetryDesc");
const orbStateBtns = document.querySelectorAll(".orb-state-btn");

if (telemetryOrb && orbStateBtns.length > 0) {
  orbStateBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetState = btn.dataset.state;
      const title = btn.dataset.title;
      const desc = btn.dataset.desc;
      const mode = btn.dataset.mode;

      if (!targetState) return;

      orbStateBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      telemetryOrb.state = targetState;
      if (telemetryBadge) telemetryBadge.textContent = targetState;
      if (telemetryTitle && title) telemetryTitle.textContent = title;
      if (telemetryDesc && desc) telemetryDesc.textContent = desc;
      if (telemetryModeTag && mode) telemetryModeTag.textContent = `MODE: ${mode} · 64px`;
    });
  });
}
