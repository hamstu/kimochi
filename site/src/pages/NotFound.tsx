import { Button } from '../components/Button'

export function NotFound() {
  return (
    <section className="container-page grid min-h-[60dvh] place-items-center py-24 text-center">
      <div>
        <p lang="ja" className="text-display text-ink-3">
          迷子
        </p>
        <h1 className="mt-4 text-title text-ink">Page not found</h1>
        <p className="mt-3 text-ink-2">That page does not exist, or it moved.</p>
        <Button href="/" variant="secondary" className="mt-8">
          Back to home
        </Button>
      </div>
    </section>
  )
}
