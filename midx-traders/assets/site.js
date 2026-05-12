const toggle = document.querySelector(".nav-toggle");
const nav = document.querySelector(".main-nav");

if (toggle && nav) {
  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });
}

const quoteForm = document.querySelector("[data-quote-form]");
const success = document.querySelector("[data-success-message]");

if (quoteForm && success) {
  quoteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = quoteForm.querySelector("button[type='submit']");
    const originalText = submitButton ? submitButton.textContent : "";
    const formData = new FormData(quoteForm);
    const payload = {
      sourceSite: "midx",
      name: formData.get("name"),
      phone: formData.get("phone"),
      email: formData.get("email"),
      eventType: formData.get("category"),
      packageName: formData.get("company"),
      location: formData.get("postcode"),
      message: formData.get("details")
    };

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Submitting...";
    }

    try {
      const response = await fetch("/api/enquiries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to submit your quote request.");
      }

      success.textContent = "Thank you. Your quote request has been received.";
      success.classList.add("show");
      quoteForm.reset();
      success.focus();
    } catch (error) {
      success.textContent = error.message || "Unable to submit your quote request.";
      success.classList.add("show");
      success.focus();
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
      }
    }
  });
}
