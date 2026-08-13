import type { Fact } from "@/lib/types";

export function FactCard({ fact }: { fact: Fact }) {
  return (
    <article className="rounded-lg border border-line bg-surface p-5">
      <p className="text-xs uppercase tracking-widest text-muted">{fact.topic}</p>
      <h3 className="mt-2 font-serif text-xl leading-snug">{fact.title}</h3>
      <p className="mt-3 font-serif text-lg leading-relaxed">{fact.key_fact}</p>
      <p className="mt-3 leading-relaxed text-muted">{fact.story}</p>
    </article>
  );
}

export function FactList({ facts }: { facts: Fact[] }) {
  return (
    <div className="flex flex-col gap-4">
      {facts.map((fact) => (
        <FactCard key={fact.id} fact={fact} />
      ))}
    </div>
  );
}
