"use strict";

const form = document.querySelector("#enrollment");
const consent = document.querySelector("#consent");
const status = document.querySelector("#status");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!consent.checked) {
    status.textContent = "Select the confirmation checkbox before submitting.";
    return;
  }

  form.querySelector("button").disabled = true;
  status.textContent = "Submitting…";
  try {
    const response = await fetch("/demo/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true }),
    });
    if (!response.ok) throw new Error("submission failed");
    status.textContent = "Enrollment submitted successfully.";
    document.body.dataset.demoComplete = "true";
  } catch {
    status.textContent = "Submission failed. Try again.";
    form.querySelector("button").disabled = false;
  }
});
