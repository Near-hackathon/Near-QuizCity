import { Link, useParams } from "react-router-dom";

const SCENE_PATTERN = /^[a-z0-9_-]{1,64}$/;

export function Component() {
  const { sceneId } = useParams();
  if (!sceneId || !SCENE_PATTERN.test(sceneId)) {
    return (
      <section className="card">
        <h1>Invalid interior</h1>
        <p className="error" role="alert">
          That interior identifier is not valid.
        </p>
        <Link className="link" to="/">
          Back to the city
        </Link>
      </section>
    );
  }
  return <h1 className="visually-hidden">Interior: {sceneId}</h1>;
}
