import { PrismaClient } from '@prisma/client'
import { hashSync } from 'bcryptjs'

// Seeds and migrations must bypass the pgbouncer pooler and use a direct connection
const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
})

const SALT_ROUNDS = 12
const DEFAULT_PASSWORD = 'password123'

async function main() {
  console.log('🌱 Seeding database…')

  // ── Users ────────────────────────────────────────────────────────────────
  const alice = await prisma.user.upsert({
    where: { email: 'alice@test.com' },
    update: {},
    create: {
      email: 'alice@test.com',
      name: 'Alice Martin',
      passwordHash: hashSync(DEFAULT_PASSWORD, SALT_ROUNDS),
    },
  })

  const bob = await prisma.user.upsert({
    where: { email: 'bob@test.com' },
    update: {},
    create: {
      email: 'bob@test.com',
      name: 'Bob Dupont',
      passwordHash: hashSync(DEFAULT_PASSWORD, SALT_ROUNDS),
    },
  })

  const carol = await prisma.user.upsert({
    where: { email: 'carol@test.com' },
    update: {},
    create: {
      email: 'carol@test.com',
      name: 'Carol Lefevre',
      passwordHash: hashSync(DEFAULT_PASSWORD, SALT_ROUNDS),
    },
  })

  console.log('✅ Users created:', alice.email, bob.email, carol.email)

  // ── Project 1 — Alice owns, Bob is editor ────────────────────────────────
  const project1 = await prisma.project.create({
    data: {
      title: 'Rapport de recherche',
      ownerId: alice.id,
      members: {
        create: [
          { userId: alice.id, role: 'OWNER' },
          { userId: bob.id, role: 'EDITOR' },
        ],
      },
      files: {
        create: [
          {
            name: 'main.tex',
            isMain: true,
            content: String.raw`\documentclass[12pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[french]{babel}
\usepackage{amsmath, amssymb}
\usepackage{geometry}
\geometry{margin=2.5cm}

\title{Rapport de recherche}
\author{Alice Martin \and Bob Dupont}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Ceci est un résumé du rapport de recherche collaboratif.
\end{abstract}

\section{Introduction}
Voici le contenu de l'introduction. La formule suivante est importante :
\[
  E = mc^2
\]

\section{Méthodes}
Description des méthodes utilisées.

\section{Conclusion}
Les résultats confirment notre hypothèse.

\end{document}
`,
          },
          {
            name: 'references.bib',
            isMain: false,
            content: String.raw`@article{einstein1905,
  author  = {Einstein, Albert},
  title   = {Zur Elektrodynamik bewegter Körper},
  journal = {Annalen der Physik},
  year    = {1905},
  volume  = {17},
  pages   = {891--921},
}
`,
          },
        ],
      },
    },
  })

  // ── Project 2 — Bob owns, Carol is viewer ────────────────────────────────
  const project2 = await prisma.project.create({
    data: {
      title: 'Présentation Beamer',
      ownerId: bob.id,
      members: {
        create: [
          { userId: bob.id, role: 'OWNER' },
          { userId: carol.id, role: 'VIEWER' },
        ],
      },
      files: {
        create: [
          {
            name: 'main.tex',
            isMain: true,
            content: String.raw`\documentclass{beamer}
\usepackage[utf8]{inputenc}
\usepackage[french]{babel}

\title{Ma Présentation}
\author{Bob Dupont}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Introduction}
  \begin{itemize}
    \item Premier point
    \item Deuxième point
    \item Troisième point
  \end{itemize}
\end{frame}

\begin{frame}{Formules}
  Voici une équation :
  \[
    \sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
  \]
\end{frame}

\end{document}
`,
          },
        ],
      },
    },
  })

  // ── Project 3 — Carol's solo CV ──────────────────────────────────────────
  const project3 = await prisma.project.create({
    data: {
      title: 'Mon CV',
      ownerId: carol.id,
      members: {
        create: [{ userId: carol.id, role: 'OWNER' }],
      },
      files: {
        create: [
          {
            name: 'main.tex',
            isMain: true,
            content: String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[french]{babel}
\usepackage{geometry}
\geometry{margin=2cm}

\begin{document}

{\LARGE \textbf{Carol Lefevre}} \\[4pt]
carol@test.com \quad | \quad Paris, France

\section*{Expérience}
\textbf{Développeuse Senior} — Entreprise XYZ \hfill 2022 -- présent \\
Description du poste et des responsabilités.

\section*{Formation}
\textbf{Master Informatique} — Université Paris-Saclay \hfill 2020 \\

\section*{Compétences}
TypeScript, React, Node.js, \LaTeX, PostgreSQL

\end{document}
`,
          },
        ],
      },
    },
  })

  console.log('✅ Projects created:', project1.title, project2.title, project3.title)

  console.log('\n📋 Comptes de test :')
  console.log('  alice@test.com   /  password123  (owner: Rapport de recherche)')
  console.log('  bob@test.com     /  password123  (owner: Présentation Beamer)')
  console.log('  carol@test.com   /  password123  (owner: Mon CV)')
  console.log('\n✅ Seed terminé.')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
