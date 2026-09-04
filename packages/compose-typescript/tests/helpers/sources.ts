/** A written plugin that registers one tool and answers calls to it. */
export const adder = `const setup: Setup = async ({ id, stubs }) => {
  await stubs.tools({ name: id, handler: 'add' })
}
export default setup

export async function add(input: { a: number; b: number }) {
  return input.a + input.b
}
`;
