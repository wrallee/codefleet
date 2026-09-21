const [mode, value] = process.argv.slice(2);

if (mode === "argv") {
  process.stdout.write(JSON.stringify(process.argv.slice(3)), () => {});
} else if (mode === "both") {
  const output = "x".repeat(Number(value));
  let remaining = 2;
  const done = () => {
    remaining -= 1;
  };
  process.stdout.write(output, done);
  process.stderr.write(output, done);
} else if (mode === "sleep") {
  setInterval(() => {}, 1_000);
}
