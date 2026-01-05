const dedent = require('dedent');
const { EModelEndpoint, ArtifactModes } = require('librechat-data-provider');
const { generateShadcnPrompt } = require('~/app/clients/prompts/shadcn-docs/generate');
const { components } = require('~/app/clients/prompts/shadcn-docs/components');

/** @deprecated */
// eslint-disable-next-line no-unused-vars
const artifactsPromptV1 = dedent`The assistant can create and reference artifacts during conversations.
  
Artifacts are for substantial, self-contained content that users might modify or reuse, displayed in a separate UI window for clarity.

# Good artifacts are...
- Substantial content (>15 lines)
- Content that the user is likely to modify, iterate on, or take ownership of
- Self-contained, complex content that can be understood on its own, without context from the conversation
- Content intended for eventual use outside the conversation (e.g., reports, emails, presentations)
- Content likely to be referenced or reused multiple times

# Don't use artifacts for...
- Simple, informational, or short content, such as brief code snippets, mathematical equations, or small examples
- Primarily explanatory, instructional, or illustrative content, such as examples provided to clarify a concept
- Suggestions, commentary, or feedback on existing artifacts
- Conversational or explanatory content that doesn't represent a standalone piece of work
- Content that is dependent on the current conversational context to be useful
- Content that is unlikely to be modified or iterated upon by the user
- Request from users that appears to be a one-off question

# Usage notes
- One artifact per message unless specifically requested
- Prefer in-line content (don't use artifacts) when possible. Unnecessary use of artifacts can be jarring for users.
- If a user asks the assistant to "draw an SVG" or "make a website," the assistant does not need to explain that it doesn't have these capabilities. Creating the code and placing it within the appropriate artifact will fulfill the user's intentions.
- If asked to generate an image, the assistant can offer an SVG instead. The assistant isn't very proficient at making SVG images but should engage with the task positively. Self-deprecating humor about its abilities can make it an entertaining experience for users.
- The assistant errs on the side of simplicity and avoids overusing artifacts for content that can be effectively presented within the conversation.
- Always provide complete, specific, and fully functional content without any placeholders, ellipses, or 'remains the same' comments.

<artifact_instructions>
  When collaborating with the user on creating content that falls into compatible categories, the assistant should follow these steps:

  1. Create the artifact using the following format:

     :::artifact{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
     \`\`\`
     Your artifact content here
     \`\`\`
     :::

  2. Assign an identifier to the \`identifier\` attribute. For updates, reuse the prior identifier. For new artifacts, the identifier should be descriptive and relevant to the content, using kebab-case (e.g., "example-code-snippet"). This identifier will be used consistently throughout the artifact's lifecycle, even when updating or iterating on the artifact.
  3. Include a \`title\` attribute to provide a brief title or description of the content.
  4. Add a \`type\` attribute to specify the type of content the artifact represents. Assign one of the following values to the \`type\` attribute:
    - HTML: "text/html"
      - The user interface can render single file HTML pages placed within the artifact tags. HTML, JS, and CSS should be in a single file when using the \`text/html\` type.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - The only place external scripts can be imported from is https://cdnjs.cloudflare.com
    - Mermaid Diagrams: "application/vnd.mermaid"
      - The user interface will render Mermaid diagrams placed within the artifact tags.
    - React Components: "application/vnd.react"
      - Use this for displaying either: React elements, e.g. \`<strong>Hello World!</strong>\`, React pure functional components, e.g. \`() => <strong>Hello World!</strong>\`, React functional components with Hooks, or React component classes
      - When creating a React component, ensure it has no required props (or provide default values for all props) and use a default export.
      - Use Tailwind classes for styling. DO NOT USE ARBITRARY VALUES (e.g. \`h-[600px]\`).
      - Base React is available to be imported. To use hooks, first import it at the top of the artifact, e.g. \`import { useState } from "react"\`
      - The lucide-react@0.263.1 library is available to be imported. e.g. \`import { Camera } from "lucide-react"\` & \`<Camera color="red" size={48} />\`
      - The recharts charting library is available to be imported, e.g. \`import { LineChart, XAxis, ... } from "recharts"\` & \`<LineChart ...><XAxis dataKey="name"> ...\`
      - The three.js library is available to be imported, e.g. \`import * as THREE from "three";\`
      - The date-fns library is available to be imported, e.g. \`import { compareAsc, format } from "date-fns";\`
      - The react-day-picker library is available to be imported, e.g. \`import { DayPicker } from "react-day-picker";\`
      - The assistant can use prebuilt components from the \`shadcn/ui\` library after it is imported: \`import { Alert, AlertDescription, AlertTitle, AlertDialog, AlertDialogAction } from '/components/ui/alert';\`. If using components from the shadcn/ui library, the assistant mentions this to the user and offers to help them install the components if necessary.
      - Components MUST be imported from \`/components/ui/name\` and NOT from \`/components/name\` or \`@/components/ui/name\`.
      - NO OTHER LIBRARIES (e.g. zod, hookform) ARE INSTALLED OR ABLE TO BE IMPORTED.
      - Images from the web are not allowed, but you can use placeholder images by specifying the width and height like so \`<img src="/api/placeholder/400/320" alt="placeholder" />\`
      - If you are unable to follow the above requirements for any reason, don't use artifacts and use regular code blocks instead, which will not attempt to render the component.
  5. Include the complete and updated content of the artifact, without any truncation or minimization. Don't use "// rest of the code remains the same...".
  6. If unsure whether the content qualifies as an artifact, if an artifact should be updated, or which type to assign to an artifact, err on the side of not creating an artifact.
  7. Always use triple backticks (\`\`\`) to enclose the content within the artifact, regardless of the content type.
</artifact_instructions>

Here are some examples of correct usage of artifacts:

<examples>
  <example_docstring>
    This example demonstrates how to create a Mermaid artifact for a simple flow chart.
  </example_docstring>

  <example>
    <user_query>Can you create a simple flow chart showing the process of making tea using Mermaid?</user_query>

    <assistant_response>
      Sure! Here's a simple flow chart depicting the process of making tea using Mermaid syntax:

      :::artifact{identifier="tea-making-flowchart" type="application/vnd.mermaid" title="Flow chart: Making Tea"}
      \`\`\`mermaid
      graph TD
          A[Start] --> B{Water boiled?}
          B -->|Yes| C[Add tea leaves to cup]
          B -->|No| D[Boil water]
          D --> B
          C --> E[Pour boiling water into cup]
          E --> F[Steep tea for desired time]
          F --> G[Remove tea leaves]
          G --> H[Add milk or sugar, if desired]
          H --> I[Enjoy your tea!]
          I --> J[End]
      \`\`\`
      :::

      This flow chart uses Mermaid syntax to visualize the steps involved in making a cup of tea. Here's a brief explanation of the process:

      1. Start
      2. Check if water is boiled
      3. If not boiled, boil the water
      4. Once water is boiled, add tea leaves to the cup
      5. Pour boiling water into the cup
      6. Steep the tea for the desired time
      7. Remove the tea leaves
      8. Optionally add milk or sugar
      9. Enjoy your tea!
      10. End

      This chart provides a clear visual representation of the tea-making process. You can easily modify or expand this chart if you want to add more details or steps to the process. Let me know if you'd like any changes or have any questions!
    </assistant_response>
  </example>
</examples>`;

const artifactsPrompt = dedent`
**🚨 CRITICAL WARNING FOR ARTIFACTUPDATE 🚨**

When making updates to artifacts:
- **CRITICAL: Line 0 is the FIRST LINE OF CODE INSIDE THE ARTIFACT, NOT the opening \`\`\` or :::artifact tag**
- **DO NOT count the :::artifact line, opening \`\`\`, or closing \`\`\` - ONLY count the actual code content**
- DO NOT ASSUME THE LOCATION OF THE TARGET TEXT - YOU MUST SEARCH FOR IT IN THE ARTIFACT
- You MUST follow the "🔴 MANDATORY INTERNAL VERIFICATION PROTOCOL 🔴" below to find the correct line and column numbers
- You MUST follow the "⚠️ ABSOLUTE PROHIBITIONS - DO NOT BE LAZY ⚠️" rules below to avoid corrupting the artifact
- Line numbers are 0-indexed (first line OF CODE = 0, second line OF CODE = 1, etc.)
- Column numbers are 0-indexed (first character = 0, second character = 1, etc.)
- endColumn is EXCLUSIVE (position after the last character of the text)
- **EVERY \\n CHARACTER CREATES A NEW LINE - COUNT THEM ALL**
- **YOU MUST VERIFY THE ACTUAL CONTENT OF THE TARGET LINE**
- **DO NOT BE LAZY - DO NOT ASSUME - DO NOT GUESS**
- **COUNT INTERNALLY - DO NOT SHOW THE COUNTING PROCESS IN YOUR RESPONSE**
- You MUST only provide ONE artifactupdate block per response

**If your location is wrong, the entire update will fail and corrupt the artifact.**

---

**🔴 CRITICAL LINE COUNTING RULE 🔴**

**Line 0 = THE FIRST LINE OF ACTUAL CODE, NOT THE ARTIFACT WRAPPER**

Example artifact structure:
\`\`\`
:::artifact{identifier="example" type="text/html" title="Example"}  ← DO NOT COUNT THIS
\`\`\`                                                                ← DO NOT COUNT THIS
<!DOCTYPE html>                                                      ← THIS IS LINE 0
<html>                                                               ← THIS IS LINE 1
<head>                                                               ← THIS IS LINE 2
...
\`\`\`                                                                ← DO NOT COUNT THIS
:::                                                                  ← DO NOT COUNT THIS
\`\`\`

**ONLY the actual code content between the backticks is counted!**

---

**⚠️ ABSOLUTE PROHIBITIONS - DO NOT BE LAZY ⚠️**

**YOU ARE FORBIDDEN FROM:**

❌ **ASSUMING line numbers** - You must COUNT from Line 0, every single line
❌ **GUESSING where something is** - You must FIND the actual text in the artifact
❌ **ESTIMATING positions** - You must COUNT characters exactly
❌ **SKIPPING verification** - You must CHECK the line content matches
❌ **TAKING SHORTCUTS** - You must follow the full protocol
❌ **BEING LAZY with counting** - You must count EVERY \\n including blanks
❌ **ASSUMING context** - You must VERIFY you're in the right section (body, style, script)
❌ **USING MEMORY** - You must read the actual artifact content
❌ **PATTERN MATCHING** - Just because it "looks like line 10" doesn't mean it is
❌ **RUSHING** - Take the time to count accurately

**YOU MUST:**

✅ **READ the actual artifact** - Look at the real content
✅ **SEARCH for your target text** - Find it explicitly
✅ **COUNT every line from 0** - No shortcuts, make sure to count all line breaks and empty lines
✅ **COUNT characters for columns** - From position 0 on the target line
✅ **VERIFY the line content** - Make sure it matches what you expect
✅ **CHECK the context** - Ensure you're in the right code section
✅ **DOUBLE-CHECK everything** - Count twice if needed
✅ **BE THOROUGH** - Accuracy over speed

**IF YOU ARE BEING LAZY, YOU WILL CORRUPT THE ARTIFACT AND BREAK THE CODE.**

---

**🔴 MANDATORY INTERNAL VERIFICATION PROTOCOL 🔴**

**CRITICAL: Before providing line numbers, you MUST internally verify:**

**STEP 1: UNDERSTAND THE REQUEST**
What am I being asked to change/add? Where does it logically belong?
**DO NOT ASSUME - Actually think about where this should go!**

**STEP 2: READ THE ARTIFACT CAREFULLY**
Look at the ACTUAL artifact content. Don't use memory or assumptions.
**DO NOT BE LAZY - Read the entire artifact if needed!**

**STEP 3: SEARCH FOR THE TARGET**
Find the specific text or location in the artifact. 
**DO NOT GUESS - Actually search for it character by character!**

For insertions/additions:
- If adding HTML → Find the '<body>' section, look inside it
- If adding CSS → Find the '<style>' section, look inside it  
- If adding to a list → Find the last item in that list
- **DO NOT ASSUME WHERE IT GOES - FIND THE ACTUAL LOCATION!**

For replacements:
- Find the EXACT text you're replacing
- **DO NOT ASSUME it's there - VERIFY you found it!**

**STEP 4: COUNT LINES TO THAT LOCATION - EXACT METHOD**
Count every \\n from the start (Line 0 = first line) to reach your target.
**DO NOT BE LAZY - Count every single line including blanks!**

**CRITICAL: HOW THE CODE ACTUALLY WORKS:**
The system uses 'content.split('\\n')' to create an array of lines.
- Line 0 = lines[0] = everything before the first \\n
- Line 1 = lines[1] = everything between first \\n and second \\n
- Line 2 = lines[2] = everything between second \\n and third \\n
- EVEN IF A LINE IS EMPTY, it's still in the array!

**EXACT COUNTING METHOD - DO THIS STEP BY STEP:**

1. **Start with the artifact content (no wrappers)**
2. **Place a cursor at position 0 (the very beginning)**
3. **Initialize line counter to 0**
4. **Scan forward character by character:**
   - All characters BEFORE the first \\n belong to Line 0
   - When you hit the FIRST \\n, increment counter to 1
   - All characters AFTER that \\n and BEFORE the next \\n belong to Line 1
   - When you hit the SECOND \\n, increment counter to 2
   - Continue this process...
5. **When you find your target text, the current line counter is the line number**

**CONCRETE EXAMPLE:**

Content: "<!DOCTYPE html>\\n<html>\\n<body>\\n  <h1>Hello</h1>\\n  <button>Click</button>\\n</body>"

Let me count with cursor position:
- Position 0-14: "<!DOCTYPE html>" → This is Line 0 (before first \\n)
- Hit \\n at position 15 → Counter increments to 1
- Position 16-21: "<html>" → This is Line 1 (between 1st and 2nd \\n)
- Hit \\n at position 22 → Counter increments to 2
- Position 23-28: "<body>" → This is Line 2
- Hit \\n at position 29 → Counter increments to 3
- Position 30-46: "  <h1>Hello</h1>" → This is Line 3
- Hit \\n at position 47 → Counter increments to 4
- Position 48-72: "  <button>Click</button>" → This is Line 4 ← BUTTON IS HERE!
- Hit \\n at position 73 → Counter increments to 5
- Position 74-80: "</body>" → This is Line 5

**RESULT: The button is on Line 4 (NOT 3, NOT 5)**

**EMPTY LINES STILL COUNT:**

Content: "<body>\\n  <div>\\n\\n    <button>"
- Line 0: "<body>"
- Line 1: "  <div>"
- Line 2: "" (EMPTY but still a line!)
- Line 3: "    <button>"

**DO NOT SKIP EMPTY LINES - THEY ARE STILL LINES IN THE ARRAY!**

**STEP 5: VERIFY THE LINE CONTENT**
Quote the ACTUAL line content to yourself. Does it match what you expect?
**DO NOT ASSUME - Check character by character!**

Questions to ask:
- Does this line contain the text I'm looking for?
- If adding HTML, am I inside '<body>' tags (not '<style>' or '<script>')?
- If changing CSS, am I inside a '<style>' block or CSS rule?
- If changing JS, am I inside a '<script>' block?
- Does the line content make sense for this change?

**STEP 6: VERIFY CONTEXT (SURROUNDING LINES)**
Look at the lines before and after. Am I in the right section?
**DO NOT ASSUME - Check the actual surrounding content!**

Check:
- What's on the line before my target?
- What's on the line after my target?
- Am I inside the correct HTML/CSS/JS section?
- Would a human put this change here?

**STEP 7: COUNT CHARACTERS FOR COLUMNS**
On the target line, count characters from position 0.
**DO NOT ESTIMATE - Count every character including spaces!**

**STEP 8: FINAL SANITY CHECK**
Before sending, ask yourself:
- Did I actually read the artifact, or did I guess?
- Did I COUNT every line, or did I estimate?
- Did I VERIFY the line content, or did I assume?
- Did I CHECK the context, or did I skip it?

**IF YOU ANSWERED "GUESSED", "ESTIMATED", "ASSUMED", OR "SKIPPED" TO ANY QUESTION, START OVER!**

---

**CRITICAL SANITY CHECKS (MUST VERIFY INTERNALLY):**

Before sending your response, verify:

✓ **Content Check**: Did I find the ACTUAL text I'm looking for?
✓ **Location Check**: Am I in the right section? (CSS in style, HTML in body, etc.)
✓ **Line Number Check**: Did I count every \\n including empty lines from Line 0?
✓ **Context Check**: Do the surrounding lines make sense for this change?
✓ **Logic Check**: Would a human put this change in this location?
✓ **Character Check**: Did I count characters exactly, not estimate?
✓ **No Assumptions**: Did I verify everything instead of assuming?
✓ **No Laziness**: Did I do the full counting process?

**EXAMPLE OF CORRECT INTERNAL VERIFICATION:**

User asks: "Add a paragraph saying 'Hello' to the page"

❌ WRONG THINKING (LAZY):
"I'll add it... paragraphs usually go around line 35... that's probably good"
[Guesses line number without counting]
[Inserts into CSS block by mistake because didn't verify context]

✅ CORRECT THINKING (THOROUGH):
"Adding HTML paragraph → Must go in <body> section, NOT in <style> or <script>
Let me READ the artifact and FIND the <body> tag...
I see '<body>' opening tag
I need to SEARCH inside the body for where to add this
I see there's a '<div class="card">' with content
The last element inside appears to be a '<button>'
I should add the paragraph after the button
Let me COUNT lines from the very start:
Line 0: <!DOCTYPE html>
Line 1: <html lang="en">
Line 2: <head>
...counting every single line...
Line 31: (blank line)
Line 32:     <div class="card">
Line 33:         <h1>Hello World!</h1>
Line 34:         <p>This is a tiny website with minimal code.</p>
Line 35:         <button onclick="alert('Welcome!')">Click Me</button>
Line 36:     </div>

I want to add after the button. The button ends on Line 35.
Let me VERIFY Line 35 content: '        <button onclick="alert(\'Welcome!\')">Click Me</button>'
YES - that's the button line!
Context check: Line 34 is a paragraph, Line 35 is button, Line 36 is closing div
This is INSIDE the body, INSIDE the card div - correct location!
Insertion point: end of Line 35
Line 35 length: let me COUNT characters... 71 characters
startColumn: 71, endColumn: 71 (insertion)
VERIFIED - this is the correct location!"

---

**RESPONSE FORMAT:**

Your response must be clean and concise:

[Brief description of change]

:::selection
Location of update:
- originalText: "exact text"
- startLine: X
- endLine: X
- startColumn: N
- endColumn: M
:::

:::artifactupdate{identifier="id" type="type" title="Title"}
replacement text only
:::

[Brief confirmation]

**DO NOT SHOW YOUR INTERNAL COUNTING OR VERIFICATION PROCESS IN YOUR RESPONSE**
**The user only sees the clean output - all verification is internal**

---

The assistant can create and reference artifacts during conversations.
  
Artifacts are for substantial, self-contained content that users might modify or reuse, displayed in a separate UI window for clarity.

# Good artifacts are...
- Substantial content (>15 lines)
- Content that the user is likely to modify, iterate on, or take ownership of
- Self-contained, complex content that can be understood on its own, without context from the conversation
- Content intended for eventual use outside the conversation (e.g., reports, emails, presentations)
- Content likely to be referenced or reused multiple times

# Don't use artifacts for...
- Simple, informational, or short content, such as brief code snippets, mathematical equations, or small examples
- Primarily explanatory, instructional, or illustrative content, such as examples provided to clarify a concept
- Suggestions, commentary, or feedback on existing artifacts
- Conversational or explanatory content that doesn't represent a standalone piece of work
- Content that is dependent on the current conversational context to be useful
- Content that is unlikely to be modified or iterated upon by the user
- Request from users that appears to be a one-off question

# Usage notes
- One artifact per message unless specifically requested
- Prefer in-line content (don't use artifacts) when possible
- Always provide complete, specific, and fully functional content for artifacts without any snippets, placeholders, ellipses, or 'remains the same' comments
- CRITICAL: After creating an artifact for the first time, ALL subsequent modifications or iterations MUST use artifactupdate unless the user explicitly requests a completely new artifact.
- When a user asks you to modify, update, improve, or change something about an artifact you created earlier in the conversation, you MUST use artifactupdate with the same identifier as the original artifact.

## Artifact_Instructions

  1. **CREATE** new artifacts using this format:

     :::artifact{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
     \`\`\`
     Your artifact content here
     \`\`\`
     :::

  2. **UPDATE** existing artifacts using artifactupdate. 
  
     IMPORTANT: Unless the user explicitly requests a NEW artifact, you should ALWAYS use artifactupdate for modifications and only send back one artifactupdate block per response.
  
     Use artifactupdate for changes such as:
     - "Change the button color to red" → use artifactupdate
     - "Add a reset button" → use artifactupdate
     - "Make the title bigger" → use artifactupdate
     - "Fix the spacing" → use artifactupdate
     
     Only use artifact (not artifactupdate) when:
     - The user explicitly asks for a "new" artifact
     - The user asks for something completely different from the existing artifact
     - This is the very first artifact being created in the conversation

     :::artifactupdate{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
     Your updated artifact content here (NO TRIPLE QUOTES, NO BACKTICKS - just the raw content)
     :::

  3. **CRITICAL RULES FOR ARTIFACTUPDATE:**
  
     **RULE 1: PROVIDE COMPLETE CONTEXT FOR CHANGES**
     - You MUST send back the COMPLETE LINE or STATEMENT being changed
     - Send ONLY ONE artifactupdate block per response
     - DO NOT send just isolated values - provide the full context
     - ✅ CORRECT: If changing a color, send "background: #0000;" (the complete CSS property)
     - ❌ WRONG: Sending just "#0000" without context
     - ✅ CORRECT: If changing a class, send 'className="bg-red-500 text-white"' (the complete attribute)
     - ❌ WRONG: Sending just "bg-red-500" without the attribute name
     - **PROVIDE ENOUGH CONTEXT so the replacement is clear and unambiguous**
     
     **RULE 2: FIND THE CORRECT LOCATION FIRST (DO NOT GUESS)**
     
     Before counting lines, you MUST:
     
     1. **Understand what you're changing** - HTML? CSS? JavaScript? Text content?
        **DO NOT ASSUME - actually read and understand the request!**
     
     2. **Find where it belongs** - 
        - HTML content → must be in '<body>' section
        - CSS rules → must be in '<style>' section or CSS file
        - JavaScript → must be in '<script>' section or JS file
        - Attributes → must be on the correct HTML element
        **DO NOT GUESS - actually search for the correct section!**
     
     3. **Search for landmarks** - Find opening tags like '<body>', '<style>', '<script>'
        **DO NOT ASSUME you know where they are - actually find them!**
     
     4. **Identify the exact target** - Find the specific line with the text you're changing
        **DO NOT ESTIMATE - find the actual text character by character!**
     
     **RULE 3: COUNT LINES ACCURATELY (DO NOT SKIP OR ESTIMATE)**
     
     After finding the correct location:
     
     1. **Count every \\n from the start** - Each \\n creates a new line
        **DO NOT BE LAZY - count every single one!**
     
     2. **Start at Line 0** - First line is always Line 0
        **DO NOT FORGET - 0-indexed for both lines and columns!**
     
     3. **Don't skip empty lines** - Blank lines between two \\n still count
        **DO NOT SKIP - empty lines have line numbers too!**
     
     4. **Verify the line content** - The line number you calculated should contain the text you expect
        **DO NOT ASSUME - actually check the content matches!**
     
     **RULE 4: VERIFY BEFORE SENDING (DO NOT RUSH)**
     
     Before providing the :::selection block, internally verify:
     
     ✓ Is this the right section of code? (CSS in style, HTML in body, etc.)
     ✓ Does the target line contain the text I expect?
     ✓ Does this location make logical sense for the change?
     ✓ Did I count all newlines including empty lines?
     ✓ Is my originalText an exact character-for-character match?
     ✓ Did I actually read and VERIFY, or did I guess?
     
     **IF YOU CANNOT ANSWER "YES" TO ALL OF THESE, START OVER!**
     
     **RULE 5: CLEAN RESPONSE**
     
     Your response should contain ONLY:
     - Brief description (1-2 sentences)
     - :::selection block
     - :::artifactupdate block
     - Brief confirmation (1 sentence)

  4. **Artifact Identifier**: Use descriptive kebab-case (e.g., "react-counter", "website-styles"). Reuse the same identifier for all updates to that artifact.

  5. **Artifact Title**: Brief description of the content.

  6. **Artifact Types**:
    - HTML: "text/html" - Single file HTML with inline CSS/JS
    - SVG: "image/svg+xml" - Scalable Vector Graphics
    - Markdown: "text/markdown" or "text/md" - Standard Markdown
    - Mermaid: "application/vnd.mermaid" - Diagrams
    - React: "application/vnd.react" - React components (use Tailwind, no arbitrary values)

  7. **CRITICAL: For artifactupdate, do NOT wrap content in triple quotes or backticks - send only the raw replacement text**
  
  8. Always start artifacts with :::artifact or :::artifactupdate and end with :::

## end Artifact_instructions

## examples

  <example>
    <user_query>Create a simple React counter component</user_query>
    <assistant_response>
      Here's a simple React counter component:

      :::artifact{identifier="react-counter" type="application/vnd.react" title="React Counter"}
      '''
      import { useState } from 'react';

      export default function Counter() {
        const [count, setCount] = useState(0);
        return (
          <div className="p-4">
            <p className="mb-2">Count: {count}</p>
            <button className="bg-blue-500 text-white px-4 py-2 rounded" onClick={() => setCount(count + 1)}>
              Increment
            </button>
          </div>
        );
      }
      '''
      :::
    </assistant_response>
  </example>

  <example>
    <user_query>Change the button color to red</user_query>
    <assistant_response>
      I'll change the button color from blue to red.

      :::selection
      Location of update:
      - originalText: 'className="bg-blue-500 text-white px-4 py-2 rounded"'
      - startLine: 7
      - endLine: 7
      - startColumn: 20
      - endColumn: 71
      :::

      :::artifactupdate{identifier="react-counter" type="application/vnd.react" title="React Counter"}
      className="bg-red-500 text-white px-4 py-2 rounded"
      :::

      The button is now red.
    </assistant_response>
  </example>

  <example>
    <user_query>Add a footer paragraph below the button</user_query>
    <assistant_response>
      I'll add a footer paragraph below the button.

      :::selection
      Location of update:
      - originalText: ""
      - startLine: 9
      - endLine: 9
      - startColumn: 18
      - endColumn: 18
      :::

      :::artifactupdate{identifier="react-counter" type="application/vnd.react" title="React Counter"}
      
            <p className="mt-4 text-gray-600">Thanks for visiting!</p>
      :::

      Added a footer paragraph.
    </assistant_response>
  </example>

  <example>
    <user_query>Change the page background to light blue</user_query>
    <assistant_response>
      I'll change the background color to light blue.

      :::selection
      Location of update:
      - originalText: "background-color: #f4f4f4;"
      - startLine: 8
      - endLine: 8
      - startColumn: 8
      - endColumn: 34
      :::

      :::artifactupdate{identifier="simple-website" type="text/html" title="Simple Website"}
      background-color: #e8f4fd;
      :::

      The background is now light blue.
    </assistant_response>
  </example>

## end examples

**FINAL CRITICAL REMINDERS:**

1. **DO NOT BE LAZY** - Count every line, verify every assumption
2. **DO NOT GUESS** - Find the actual text, don't estimate positions
3. **DO NOT ASSUME** - Verify context, check surrounding lines
4. **DO NOT RUSH** - Take time to count accurately
5. **DO NOT SKIP** - Count empty lines, they have line numbers too

When adding HTML content, you MUST ensure you're inserting it in the '<body>' section, NOT in '<style>', '<script>', or '<head>' sections. Always verify the context of your target line!

**IF YOU ARE LAZY, YOU WILL BREAK THE CODE. BE THOROUGH.**`;

const artifactsOpenAIPrompt = dedent`
**🚨 CRITICAL LOCATION ACCURACY REQUIREMENT 🚨**

When updating artifacts, incorrect line/column positions will BREAK the code.
You MUST follow the mandatory verification process below for EVERY update.

**🔴 CRITICAL: Line 0 = FIRST LINE OF ACTUAL CODE, NOT THE \`\`\` OR :::artifact TAG 🔴**

**DO NOT COUNT:**
- The :::artifact{...} line
- The opening \`\`\` line
- The closing \`\`\` line
- The closing ::: line

**ONLY COUNT THE ACTUAL CODE CONTENT BETWEEN THE BACKTICKS!**

Example:
\`\`\`
:::artifact{identifier="example" type="text/html" title="Example"}  ← DO NOT COUNT
\`\`\`                                                                ← DO NOT COUNT
<!DOCTYPE html>                                                      ← LINE 0
<html>                                                               ← LINE 1
<head>                                                               ← LINE 2
\`\`\`                                                                ← DO NOT COUNT
:::                                                                  ← DO NOT COUNT
\`\`\`

**⚠️ MANDATORY INTERNAL COUNTING PROTOCOL ⚠️**

**CRITICAL:** You are making systematic errors by GUESSING line numbers instead of COUNTING them.

**YOU MUST COUNT INTERNALLY - BUT DO NOT SHOW THE COUNTING IN YOUR RESPONSE**

**INTERNAL COUNTING PROCESS (DO THIS IN YOUR HEAD, DON'T WRITE IT OUT):**

1. **READ the artifact content** - Don't use memory, look at the actual code
2. **FIND your target text** - Search for the exact line you need to modify
3. **COUNT from Line 0** - Start at first line (Line 0), count every \\n until you reach your target
4. **VERIFY the content** - The line number you calculated should contain your target text exactly
5. **COUNT characters** - From position 0 on that line to find startColumn/endColumn

**COUNTING RULES:**
- Line 0 = First line of actual code (not the :::artifact or \`\`\` wrapper)
- Count EVERY \\n including blank lines
- Line N means lines[N] in array terms (the N+1th line in human counting)
- **CRITICAL:** Empty lines (just \\n with no content) STILL COUNT as lines
- **DO NOT skip, ignore, or estimate empty/blank lines**
- Each \\n (newline) increments the line number by 1
- DO NOT skip empty lines
- DO NOT assume or estimate
- DO NOT use memory - look at the actual artifact

**EXAMPLE OF COUNTING WITH EMPTY LINES:**
\`\`\`
Line 0: function example() {
Line 1:   const x = 1;
Line 2:                     ← EMPTY LINE but still Line 2!
Line 3:   return x;         ← This is Line 3, NOT Line 2!
Line 4: }
\`\`\`

**YOU MUST COUNT EVERY LINE BREAK - NO EXCEPTIONS!**

**MENTAL VERIFICATION CHECKLIST (CHECK INTERNALLY, DON'T SHOW):**
- Did I actually READ the artifact, or guess from memory?
- Did I FIND the target text, or assume where it is?
- Did I COUNT every line from 0, or estimate?
- Does Line X actually contain my target text?
- Am I in the right code section (body/style/script)?

**THE GOAL:** You must be 100% accurate with line numbers, but keep your response clean and concise.

**HOW TO ACHIEVE THIS:**
- Count carefully in your internal processing
- But only output the final :::selection and :::artifactupdate blocks
- No verbose verification output
- Just accurate line/column numbers based on real counting

**REMEMBER:** If you guess instead of count, the update WILL FAIL and BREAK THE CODE.

**MANDATORY INTERNAL PROCESS FOR ALL ARTIFACTUPDATE:**

Before sending ANY artifactupdate, you MUST internally (without showing output):

1. **LOOK AT THE ACTUAL ARTIFACT** - Don't guess from memory
2. **COUNT FROM LINE 0** - The first line is ALWAYS line 0
3. **VERIFY EXACT MATCH** - Your originalText must match character-for-character
4. **CHECK THE CONTEXT** - Am I in the right code section?

**⚠️ COMMON OFF-BY-ONE ERROR TO AVOID:**

**Example:**
\`\`\`
Line 0: <!DOCTYPE html>
Line 1: <html>
...
Line 10: <body>
Line 11: <h1>Title</h1>
Line 12: <button>Click</button>  ← You want to change this

User asks: "Change the button color"
❌ WRONG: You report startLine: 11 (because you see it's the "12th line")
✅ CORRECT: You must report startLine: 12 (because arrays start at 0)
\`\`\`

**WHY THIS MATTERS:**
- When you say startLine: 11, the code looks at lines[11], which is the <h1>
- When you say startLine: 12, the code looks at lines[12], which is the <button>
- 0-based indexing means: Line N = lines[N] = the (N+1)th line in human counting

**INTERNAL COUNTING METHOD (DO NOT SHOW THIS IN YOUR RESPONSE):**

**CRITICAL: HOW THE CODE ACTUALLY WORKS:**
The system uses 'content.split('\\n')' to create an array of lines.
- Line 0 = lines[0] = everything before the first \\n
- Line 1 = lines[1] = everything between first \\n and second \\n
- Line 2 = lines[2] = everything between second \\n and third \\n
- EVEN IF A LINE IS EMPTY, it's still in the array!

**EXACT STEP-BY-STEP COUNTING:**

1. **Start with the artifact content (no wrappers)**
2. **Place a cursor at position 0 (the very beginning)**
3. **Initialize line counter to 0**
4. **Scan forward character by character:**
   - All characters BEFORE the first \\n belong to Line 0
   - When you hit the FIRST \\n, increment counter to 1
   - All characters AFTER that \\n and BEFORE the next \\n belong to Line 1
   - When you hit the SECOND \\n, increment counter to 2
   - Continue this process...
5. **When you find your target text, the current line counter is the line number**

**CONCRETE EXAMPLE:**

Content: "<!DOCTYPE html>\\n<html>\\n<body>\\n  <h1>Hello</h1>\\n  <button>Click</button>\\n</body>"

Counting with cursor position:
- Position 0-14: "<!DOCTYPE html>" → Line 0 (before first \\n)
- Hit \\n at position 15 → Counter = 1
- Position 16-21: "<html>" → Line 1 (between 1st and 2nd \\n)
- Hit \\n at position 22 → Counter = 2
- Position 23-28: "<body>" → Line 2
- Hit \\n at position 29 → Counter = 3
- Position 30-46: "  <h1>Hello</h1>" → Line 3
- Hit \\n at position 47 → Counter = 4
- Position 48-72: "  <button>Click</button>" → Line 4 ← BUTTON IS HERE!

**RESULT: Button is on Line 4 (NOT 3, NOT 5)**

**EMPTY LINES STILL COUNT:**
Content: "<body>\\n  <div>\\n\\n    <button>"
- Line 0: "<body>"
- Line 1: "  <div>"
- Line 2: "" (EMPTY but still in array!)
- Line 3: "    <button>"

**DO NOT SKIP EMPTY LINES!**

**YOUR RESPONSE SHOULD ONLY CONTAIN:**
- Brief description (1-2 sentences)
- :::selection block
- :::artifactupdate block
- Brief confirmation (1 sentence)

**DO NOT SHOW YOUR COUNTING PROCESS - ONLY THE FINAL ACCURATE RESULT**

---

**CRITICAL RULES:**

1. **Use artifactupdate for ALL modifications** - Never use artifact for updates
2. **0-based indexing** - First line = 0, second line = 1, etc. (columns are also 0-based: first character = 0)
3. **Provide complete context** - Send the COMPLETE LINE or STATEMENT being changed, not just isolated values. For example: send "background: #0000;" not just "#0000", or send 'className="bg-red-500"' not just "bg-red-500"
4. **Character-perfect match** - originalText must match exactly including spaces, quotes, etc.
5. **One update per artifactupdate** - If more than one update is required (e.g., multiple, non-contiguous changes), you MUST ask the user if they want to continue and add the next update, rather than batching multiple updates in one response. Only one update per artifactupdate is allowed.
6. **You MUST count lines and columns internally from the actual artifact content. Never assume, estimate, or infer line or column numbers from memory, prior responses, or code structure. Count internally without showing your counting process. When counting lines, treat every '\n' (newline) as a line break. Each '\n' creates a new line for line counting and verification.**

**INDEXING RULES:**

Lines (0-based):
- Line 0 = first line of actual code
- Line 1 = second line of actual code
- Line N = the (N+1)th line of actual code

Columns (0-based):
- Column 0 = first character of the line
- Column 1 = second character of the line
- Count EVERY character: spaces, tabs, quotes, brackets, etc.

---
  
Artifacts are for substantial, self-contained content that users might modify or reuse, displayed in a separate UI window for clarity.

# Good artifacts are...
- Substantial content (>15 lines)
- Content that the user is likely to modify, iterate on, or take ownership of
- Self-contained, complex content that can be understood on its own, without context from the conversation
- Content intended for eventual use outside the conversation (e.g., reports, emails, presentations)
- Content likely to be referenced or reused multiple times

# Don't use artifacts for...
- Simple, informational, or short content, such as brief code snippets, mathematical equations, or small examples
- Primarily explanatory, instructional, or illustrative content, such as examples provided to clarify a concept
- Suggestions, commentary, or feedback on existing artifacts
- Conversational or explanatory content that doesn't represent a standalone piece of work
- Content that is dependent on the current conversational context to be useful
- Content that is unlikely to be modified or iterated upon by the user
- Request from users that appears to be a one-off question

# Usage notes
- **CRITICAL:** After creating an artifact for the first time, ALL subsequent modifications or iterations MUST use artifactupdate unless the user explicitly requests a completely new artifact.
- One artifact per message unless specifically requested
- Prefer in-line content (don't use artifacts) when possible
- Always provide complete, specific, and fully functional content for artifacts without any snippets, placeholders, ellipses, or 'remains the same' comments
- If an artifact is not necessary or requested, the assistant should not mention artifacts at all

## Artifact Instructions

  1. **CREATE** new artifacts using this format:

      :::artifact{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
      \`\`\`
      Your artifact content here
      \`\`\`
      :::

  2. **UPDATE** existing artifacts using this format:

      :::artifactupdate{identifier=unique-identifier type=mime-type title="Artifact Title"}
      Only the changed text here
      :::

     **WHEN TO USE ARTIFACTUPDATE:**
     - "Change the button color to red" → use artifactupdate
     - "Add a reset button" → use artifactupdate
     - "Make the title bigger" → use artifactupdate
     - "Fix the spacing" → use artifactupdate
     - Any modification request → use artifactupdate
     
     **ONLY use artifact (not artifactupdate) when:**
     - The user explicitly asks for a "new" artifact
     - The user asks for something completely different from the existing artifact
     - This is the very first artifact being created in the conversation

  3. **LOCATION SPECIFICATION (MANDATORY FOR UPDATES):**

     Before the artifactupdate block, you MUST include a :::selection block:

     :::selection
     Location of update:
     - originalText: "exact text being replaced"
     - startLine: X
     - endLine: X
     - startColumn: N
     - endColumn: M
     :::

     :::artifactupdate{identifier=unique-identifier type=mime-type title="Title"}
     replacement text only
     :::

---

**🔴 CRITICAL: Line 0 = FIRST LINE OF ACTUAL CODE 🔴**

**DO NOT COUNT:**
- The :::artifact{...} line
- The opening \`\`\` line
- The closing \`\`\` line
- The closing ::: line

**ONLY COUNT THE ACTUAL CODE CONTENT!**

**⚠️ SPECIAL INSTRUCTIONS FOR CLAUDE & GPT MODELS - OFF-BY-ONE ERROR PREVENTION ⚠️**

**ERROR PATTERN:** You frequently report line N when the actual line is N+1 or N-1.

**MANDATORY COUNTING PROCESS:**

Step 1: Find the artifact content (ignore wrappers)

Step 2: **Use EXACT 0-based counting:**
   - FIRST line of code → Line 0
   - SECOND line of code → Line 1
   - THIRD line of code → Line 2
   - Line N means it's the (N+1)th line in human counting

Step 3: **PHYSICAL COUNTING:**
   - Point at each line: "Line 0, Line 1, Line 2..."
   - When you reach your target, STOP
   - Use THAT NUMBER (don't add/subtract 1)

Step 4: **VERIFY with array thinking:**
   - If target is on Line X
   - Then lines[X] must contain your target text
   - If it doesn't match → START OVER

**EXAMPLE:**
      \`\`\`
<!DOCTYPE html>          ← Line 0
<html>                   ← Line 1
<body>                   ← Line 2
  <h1>Hello</h1>         ← Line 3
  <button>Click</button> ← Line 4 (NOT Line 5!)
</body>                  ← Line 5
      \`\`\`

To change the button: Use Line 4 (not 3, not 5)

**VERIFICATION CHECKLIST:**
[ ] Counted from Line 0, not Line 1
[ ] Counted EVERY line including blanks
[ ] Target line contains exact text
[ ] Did NOT adjust my count by ±1

---

**DETAILED EXAMPLES:**

**EXAMPLE 1: Changing a CSS value**

User: "Change the primary color to purple"

CORRECT RESPONSE (note: no verbose counting shown, just the final result):

I'll change the primary color to purple.

:::selection
Location of update:
- originalText: "--primary: #6366F1;"
- startLine: 4
- endLine: 4
- startColumn: 8
- endColumn: 27
:::

:::artifactupdate{identifier=modern-website type=text/html title="Modern Website"}
--primary: #8B5CF6;
:::

The primary color has been changed to purple (#8B5CF6).

---

**EXAMPLE 2: Changing a className**

User: "Change bg-blue-500 to bg-red-500"

CORRECT RESPONSE (no verbose counting, just final result):

I'll change the button color to red.

:::selection
Location of update:
- originalText: 'className="bg-blue-500 text-white px-4 py-2"'
- startLine: 5
- endLine: 5
- startColumn: 12
- endColumn: 57
:::

:::artifactupdate{identifier=react-counter type=application/vnd.react title="React Counter"}
className="bg-red-500 text-white px-4 py-2"
:::

The button is now red.

---

**EXAMPLE 3: Adding new code**

User: "Add a reset button"

CORRECT RESPONSE (no verbose counting, just final result):

I'll add a reset button after the Increment button.

:::selection
Location of update:
- originalText: ""
- startLine: 3
- endLine: 3
- startColumn: 33
- endColumn: 33
:::

:::artifactupdate{identifier=react-counter type=application/vnd.react title="React Counter"}

      <button>Reset</button>
:::

Added the reset button.

---

**COMMON MISTAKES TO AVOID:**

❌ WRONG: Sending entire functions/components
❌ WRONG: Guessing line numbers without counting internally
❌ WRONG: Sending isolated values without context (e.g., just "#0000" instead of "background: #0000;")
❌ WRONG: Forgetting to count spaces and special characters
❌ WRONG: Using quotes in identifier/type attributes for artifactupdate

✅ CORRECT: Send the complete line or statement with full context
✅ CORRECT: Count internally from line 0 without showing your process
✅ CORRECT: Provide only the :::selection and :::artifactupdate blocks
✅ CORRECT: Count every character including spaces
✅ CORRECT: Use unquoted attributes for artifactupdate

---

**ARTIFACT TYPES:**

- **HTML**: "text/html" - Single file HTML with inline CSS/JS
- **SVG**: "image/svg+xml" - Scalable Vector Graphics
- **Markdown**: "text/markdown" or "text/md" - Standard Markdown
- **Mermaid**: "application/vnd.mermaid" - Diagrams and flowcharts
- **React**: "application/vnd.react" - React components (use Tailwind for styling)
- **Powerpoint**: "doc/pptx" - Presentation content
- **Excel**: "doc/xlsx" - Spreadsheet content

**React-specific notes:**
- Import hooks: 'import { useState } from "react"'
- Available libraries: lucide-react@0.394.0, recharts, three.js, date-fns, react-day-picker, shadcn/ui
- Use Tailwind classes (no arbitrary values like 'h-[600px]')
- Components must have no required props or provide defaults
- Must use default export

---

**FINAL CHECKLIST (REQUIRED FOR EVERY UPDATE):**

Before sending artifactupdate, internally verify:

□ I counted lines from line 0 (first line = 0, second line = 1, etc.)
□ I counted characters from position 0 (first character = 0, columns are 0-based)
□ My originalText is an exact character-for-character match
□ I'm sending the COMPLETE LINE or STATEMENT with full context (not just isolated values)
□ I included the :::selection block with all 5 fields
□ I used unquoted attributes in artifactupdate (identifier=value not identifier="value")
□ I counted internally without showing verbose output

**IF ANY CHECKBOX IS UNCHECKED, DO NOT SEND THE UPDATE.**

---

**Remember:** Location errors will break the artifact. Count internally but accurately. Always count lines from 0. Columns are 0-based. Always match exactly. Keep responses clean and concise.
`;

const generateArtifactsPrompt = ({ endpoint, artifacts }) => {
  if (artifacts === ArtifactModes.CUSTOM) {
    return null;
  }

  let prompt = artifactsPrompt;
  if (endpoint !== EModelEndpoint.anthropic) {
    prompt = artifactsOpenAIPrompt;
  }

  if (artifacts === ArtifactModes.SHADCNUI) {
    prompt += generateShadcnPrompt({ components, useXML: endpoint === EModelEndpoint.anthropic });
  }

  return prompt;
};

module.exports = generateArtifactsPrompt;
