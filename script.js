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
  const CONTACT_ADDRESS = ["asilerguner", "gmail.com"].join("@");

  const params = new URLSearchParams(window.location.search);
  if (params.get("topic") === "licensing") {
    document.getElementById("cf-message").value =
      "Hi Asil, I'd like a proof-of-concept license key for ComplianceWorks to try with my team.";
  }

  contactForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("cf-name").value.trim();
    const email = document.getElementById("cf-email").value.trim();
    const message = document.getElementById("cf-message").value.trim();
    const subject = encodeURIComponent(`Message from ${name} via portfolio site`);
    const body = encodeURIComponent(`${message}\n\n— ${name} (${email})`);
    window.location.href = `mailto:${CONTACT_ADDRESS}?subject=${subject}&body=${body}`;
    document.getElementById("formNote").textContent = "Opening your email app...";
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
