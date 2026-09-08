document.getElementById("year").textContent = new Date().getFullYear();

const navToggle = document.getElementById("navToggle");
const nav = document.getElementById("nav");

navToggle.addEventListener("click", () => {
  nav.classList.toggle("open");
});

nav.querySelectorAll("a").forEach((link) => {
  if (link.closest(".nav-dropdown") && link.parentElement.classList.contains("nav-dropdown")) return;
  link.addEventListener("click", () => nav.classList.remove("open"));
});

document.querySelectorAll(".nav-dropdown").forEach((dropdown) => {
  const trigger = dropdown.querySelector(":scope > a");
  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    dropdown.classList.toggle("open");
  });
});
document.addEventListener("click", (e) => {
  document.querySelectorAll(".nav-dropdown.open").forEach((dropdown) => {
    if (!dropdown.contains(e.target)) dropdown.classList.remove("open");
  });
});

const header = document.querySelector(".site-header");
if (header) {
  const updateHeader = () => header.classList.toggle("scrolled", window.scrollY > 8);
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });
}

const contactForm = document.getElementById("contactForm");
if (contactForm) {
  const params = new URLSearchParams(window.location.search);
  if (params.get("topic") === "licensing") {
    document.getElementById("cf-message").value =
      "Hi Asil, I tried the ComplianceWorks proof of concept and wanted to get in touch.";
  }

  contactForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const formNote = document.getElementById("formNote");
    const submitBtn = contactForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    formNote.textContent = "Sending...";

    fetch(contactForm.action, {
      method: "POST",
      body: new FormData(contactForm),
      headers: { Accept: "application/json" },
    })
      .then((response) => {
        if (response.ok) {
          formNote.textContent = "Thanks! Your message has been sent - I'll get back to you soon.";
          contactForm.reset();
        } else {
          formNote.textContent = "Something went wrong. Please email asilerguner@gmail.com directly.";
        }
      })
      .catch(() => {
        formNote.textContent = "Something went wrong. Please email asilerguner@gmail.com directly.";
      })
      .finally(() => {
        submitBtn.disabled = false;
      });
  });
}

const revealEls = document.querySelectorAll(".reveal");
if (revealEls.length && "IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          setTimeout(() => entry.target.classList.add("visible"), i % 3 * 60);
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );
  revealEls.forEach((el) => io.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add("visible"));
}

const lightbox = document.getElementById("lightbox");
if (lightbox) {
  const lightboxImg = document.getElementById("lightbox-img");
  document.querySelectorAll(".screenshot-card img").forEach((img) => {
    img.addEventListener("click", () => {
      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      lightbox.classList.add("open");
    });
  });
  const closeLightbox = () => lightbox.classList.remove("open");
  lightbox.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });
}
