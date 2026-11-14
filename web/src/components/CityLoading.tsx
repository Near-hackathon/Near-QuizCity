import "./CityLoading.css";

export function CityLoading({ message, overlay = false }: { message: string; overlay?: boolean }) {
  return (
    <section
      className={`city-loading${overlay ? " city-loading-overlay" : ""}`}
      aria-label="Loading Quiz City"
    >
      <div className="city-loading-card">
        <span className="city-loading-brand">QUIZ CITY</span>
        <h1>Entering the city</h1>
        <p role="status" aria-live="polite">
          {message}
        </p>
        <div className="city-loading-track" aria-hidden="true">
          <span />
        </div>
        <p className="city-loading-caption">Getting your neighbourhood ready.</p>
        <a href="/manage">Open management</a>
      </div>
    </section>
  );
}
