const enquiryForm = document.getElementById("enquiry-form");
const formStatus = document.getElementById("form-status");
const submitButton = document.getElementById("submit-button");
const eventTypeField = document.getElementById("eventType");
const packageField = document.getElementById("packageName");
const messageField = document.getElementById("message");
const contactSection = document.getElementById("quote");
const apiBase = window.location.protocol === "file:" ? "http://localhost:3000" : "";

function getQuoteHelpMessage() {
  return "The quote service is temporarily unavailable. Please try again shortly or use the WhatsApp button.";
}

async function parseJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!text || !contentType.includes("application/json")) {
    return {
      ok: false,
      data: null,
      error: getQuoteHelpMessage()
    };
  }

  try {
    return {
      ok: response.ok,
      data: JSON.parse(text),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      data: null,
      error: getQuoteHelpMessage()
    };
  }
}

async function checkQuoteBackend() {
  const response = await fetch(`${apiBase}/api/health`);
  if (!response.ok) {
    throw new Error(getQuoteHelpMessage());
  }
}

document.querySelectorAll("[data-enquiry-fill]").forEach((element) => {
  element.addEventListener("click", () => {
    const eventType = element.getAttribute("data-enquiry-fill");
    const packageName = element.getAttribute("data-package-fill");
    const message = element.getAttribute("data-message-fill");

    if (eventTypeField && eventType) {
      eventTypeField.value = eventType;
    }

    if (packageField && packageName) {
      packageField.value = packageName;
    }

    if (messageField && message) {
      messageField.value = message;
      messageField.focus();
    }

    if (contactSection) {
      contactSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.location.href = "/#quote";
    }
  });
});

if (enquiryForm && formStatus && submitButton) {
  enquiryForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(enquiryForm);
    const payload = Object.fromEntries(formData.entries());

    formStatus.textContent = "Sending your quote request...";
    formStatus.dataset.state = "";
    submitButton.disabled = true;

    try {
      await checkQuoteBackend();

      const response = await fetch(`${apiBase}/api/enquiries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = await parseJsonResponse(response);

      if (!result.ok || !result.data) {
        throw new Error((result.data && result.data.error) || result.error || "Unable to send your quote request.");
      }

      enquiryForm.reset();
      formStatus.textContent = result.data.message + " Reference: " + result.data.enquiry.id;
      formStatus.dataset.state = "success";
    } catch (error) {
      formStatus.textContent = error.message || "Unable to send your quote request right now.";
      formStatus.dataset.state = "error";
    } finally {
      submitButton.disabled = false;
    }
  });
}
