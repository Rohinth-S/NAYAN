"use strict";

const form = document.querySelector("#enrollment");
const consent = document.querySelector("#consent");
const status = document.querySelector("#status");
const password = document.querySelector("#account-password");
const reveal = document.querySelector(".reveal");

reveal?.addEventListener("click", () => {
  const isVisible = password.type === "text";
  password.type = isVisible ? "password" : "text";
  reveal.textContent = isVisible ? "Show" : "Hide";
  reveal.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!consent.checked) {
    status.textContent = "Select the confirmation checkbox before submitting.";
    status.dataset.error = "true";
    return;
  }

  form.querySelector("button").disabled = true;
  status.textContent = "Submitting…";
  delete status.dataset.error;
  try {
    const response = await fetch("/demo/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    if (!response.ok) throw new Error("submission failed");
    status.textContent = "Enrollment submitted successfully.";
    delete status.dataset.error;
    document.body.dataset.demoComplete = "true";
  } catch {
    status.textContent = "Submission failed. Try again.";
    status.dataset.error = "true";
    form.querySelector("button").disabled = false;
  }
});
