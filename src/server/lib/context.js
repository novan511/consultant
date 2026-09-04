// Shared application context — mutable singleton.
// Routes read from this instead of receiving senate at mount time.
const ctx = {
  senate: null
};

export default ctx;
