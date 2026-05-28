export type TemplateId = 'blank' | 'article' | 'report' | 'beamer' | 'cv'

export function getTemplateContent(template: TemplateId): string {
  switch (template) {
    case 'blank':
      return `\\documentclass{article}
\\begin{document}

\\end{document}
`
    case 'article':
      return `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{My Article}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
This is the abstract of the article. Briefly describe the content and findings.
\\end{abstract}

\\section{Introduction}
This is the introduction section.

\\section{Methods}
Describe your methods here.

\\section{Results}
Present your results.

\\section{Conclusion}
Summarize your findings.

\\end{document}
`
    case 'report':
      return `\\documentclass[12pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Report Title}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle
\\tableofcontents
\\newpage

\\chapter{Introduction}
This is the first chapter of the report.

\\section{Background}
Provide background information.

\\section{Objectives}
State the objectives.

\\chapter{Main Content}
This is the main content chapter.

\\section{First Section}
Content here.

\\chapter{Conclusion}
Summarize your report.

\\end{document}
`
    case 'beamer':
      return `\\documentclass[aspectratio=169]{beamer}
\\usetheme{Warsaw}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}

\\title{Presentation Title}
\\author{Author Name}
\\institute{University / Organization}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Table of Contents}
  \\tableofcontents
\\end{frame}

\\section{Introduction}

\\begin{frame}{Introduction}
  \\begin{itemize}
    \\item First point
    \\item Second point
    \\item Third point
  \\end{itemize}
\\end{frame}

\\section{Main Content}

\\begin{frame}{Main Slide}
  \\begin{columns}
    \\column{0.5\\textwidth}
    Left column content.
    \\column{0.5\\textwidth}
    Right column content.
  \\end{columns}
\\end{frame}

\\section{Conclusion}

\\begin{frame}{Conclusion}
  \\begin{block}{Summary}
    Key takeaways from the presentation.
  \\end{block}
  \\vfill
  \\centering
  Thank you for your attention!
\\end{frame}

\\end{document}
`
    case 'cv':
      return `\\documentclass[11pt,a4paper]{moderncv}
\\moderncvtheme[blue]{classic}
\\usepackage[utf8]{inputenc}
\\usepackage[scale=0.85]{geometry}

\\firstname{John}
\\familyname{Doe}
\\title{Software Engineer}
\\address{123 Main Street}{City, Country}
\\mobile{+1 234 567 8901}
\\email{john.doe@example.com}
\\homepage{www.johndoe.com}

\\begin{document}

\\maketitle

\\section{Experience}
\\cventry{2020--Present}{Senior Developer}{Tech Company}{City}{}{
  \\begin{itemize}
    \\item Led development of key features
    \\item Managed a team of 5 engineers
  \\end{itemize}
}
\\cventry{2018--2020}{Junior Developer}{Startup}{City}{}{
  Developed and maintained web applications.
}

\\section{Education}
\\cventry{2014--2018}{B.Sc. Computer Science}{University Name}{City}{GPA: 3.8/4.0}{}

\\section{Skills}
\\cvline{Languages}{TypeScript, Python, Rust, Java}
\\cvline{Frameworks}{React, Node.js, FastAPI}
\\cvline{Tools}{Git, Docker, Kubernetes, Terraform}

\\section{Languages}
\\cvlanguage{English}{Native}{}
\\cvlanguage{French}{Intermediate}{}

\\end{document}
`
    default:
      return getTemplateContent('blank')
  }
}
