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
  quoteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    success.classList.add("show");
    quoteForm.reset();
    success.focus();
  });
}
