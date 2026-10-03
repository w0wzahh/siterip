(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(pointer: fine)").matches;

  /* custom neobrutal cursor — same arrow as w0wzahh.link */
  if (fine && !reduced) {
    const cur = document.createElement("div");
    cur.id = "cursor";
    cur.innerHTML =
      '<svg width="30" height="34" viewBox="0 0 30 34">' +
      '<path d="M7 5 L23 18 L16.8 19.2 L20.2 27.8 L16.9 29.2 L13.4 20.8 L7 25 Z" transform="translate(2.5 2.5)" fill="#000"/>' +
      '<path class="arrow" d="M7 5 L23 18 L16.8 19.2 L20.2 27.8 L16.9 29.2 L13.4 20.8 L7 25 Z" stroke="#000" stroke-width="2.5" stroke-linejoin="round"/>' +
      "</svg>";
    document.body.appendChild(cur);
    document.body.classList.add("has-cursor");

    let tx = -100, ty = -100, cx = -100, cy = -100;
    addEventListener("pointermove", (e) => { tx = e.clientX; ty = e.clientY; });
    addEventListener("pointerover", (e) => {
      cur.classList.toggle(
        "hover",
        !!e.target.closest?.("a, button, [role='button'], input, textarea, select, label")
      );
    });
    addEventListener("pointerdown", () => cur.classList.add("down"));
    addEventListener("pointerup", () => cur.classList.remove("down"));

    (function follow() {
      cx += (tx - cx) * 0.24; // spring-damped follow
      cy += (ty - cy) * 0.24;
      cur.style.transform = `translate(${cx - 3}px, ${cy - 3}px)`;
      requestAnimationFrame(follow);
    })();
  }

  /* scroll progress bar — lerped like the site's spring */
  const bar = document.getElementById("progressbar");
  let target = 0, cur2 = 0;
  addEventListener("scroll", () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    target = max > 0 ? scrollY / max : 0;
  }, { passive: true });
  (function slide() {
    cur2 += (target - cur2) * 0.12;
    bar.style.transform = `scaleX(${cur2})`;
    requestAnimationFrame(slide);
  })();

  /* scroll-triggered reveals — .rv → .rv-in with sibling stagger */
  if (!reduced) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("rv-in");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.15 });

    const seen = new Map();
    document
      .querySelectorAll(".stat, .feat, .card, .sec-head h2")
      .forEach((el) => {
        const n = seen.get(el.parentElement) || 0;
        seen.set(el.parentElement, n + 1);
        el.style.transitionDelay = `${n * 70}ms`;
        el.classList.add("rv");
        io.observe(el);
      });
  }
})();
