using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Real disposable native controls. No input injection, automation APIs or credentials.
sealed class ComputerFixture : Form {
    readonly string directory;
    readonly TextBox draft = new TextBox();
    readonly Label result = new Label();
    readonly Label scrollReceipt = new Label();
    readonly ListBox cards = new ListBox();
    readonly List<object> events = new List<object>();
    string focused = "", applied = "";
    int applies, scroll, secondary;
    bool closed;
    string dragItem;

    ComputerFixture(string path) {
        directory = Path.GetFullPath(path);
        if (!Directory.Exists(directory) || File.Exists(Path.Combine(directory, "state.json")))
            throw new InvalidOperationException("Use a prepared fresh private fixture directory");
        Text = "Clankie Windows Computer Fixture v1";
        Name = "ClankieWindowsComputerFixture";
        ClientSize = new Size(820, 700);
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;
        var title = new Label { Text = "Windows native fixture — only this window is authorized", Location = new Point(20, 16), Size = new Size(780, 28) };
        Controls.Add(title);
        Controls.Add(new Label { Text = "Draft text", Location = new Point(20, 54), Size = new Size(780, 24) });
        draft.Name = "draft"; draft.AccessibleName = "Draft text";
        draft.Location = new Point(20, 84); draft.Size = new Size(780, 64);
        draft.Multiline = true; draft.AcceptsReturn = true; draft.TabIndex = 0;
        Controls.Add(draft);
        draft.Enter += delegate { focused = "draft"; Record("focus", focused); };
        draft.TextChanged += delegate { Record("text", draft.Text); };
        var apply = new Button { Name = "apply", AccessibleName = "Apply draft", Text = "Apply draft", Location = new Point(20, 164), Size = new Size(160, 36), TabIndex = 1 };
        apply.Enter += delegate { focused = "apply"; Record("focus", focused); };
        apply.Click += delegate { applies++; applied = draft.Text; result.Text = "Applied " + applies + ": " + applied; Record("apply", applied); };
        Controls.Add(apply);
        result.Text = "Applied 0: "; result.Name = "applyReceipt";
        result.Location = new Point(200, 166); result.Size = new Size(600, 32); Controls.Add(result);
        var focus = new Label { Location = new Point(20, 214), Size = new Size(780, 28), Name = "focusReceipt" };
        draft.Enter += delegate { focus.Text = "Focused: draft"; };
        apply.Enter += delegate { focus.Text = "Focused: apply"; };
        Controls.Add(focus);
        var panel = new Panel { Name = "scroll", AccessibleName = "Scroll region", Location = new Point(20, 254), Size = new Size(500, 310), AutoScroll = true, TabIndex = 2 };
        for (int i = 0; i < 25; i++) panel.Controls.Add(new Label { Text = "Scroll row " + i, Location = new Point(8, i * 38), Size = new Size(320, 28) });
        panel.Scroll += delegate(object sender, ScrollEventArgs e) { scroll = e.NewValue; scrollReceipt.Text = "Scroll offset: " + scroll; Record("scroll", scroll); };
        Controls.Add(panel);
        scrollReceipt.Text = "Scroll offset: 0"; scrollReceipt.Name = "scrollReceipt";
        scrollReceipt.Location = new Point(20, 578); scrollReceipt.Size = new Size(370, 30); Controls.Add(scrollReceipt);
        cards.Name = "cards"; cards.AccessibleName = "Card order"; cards.Location = new Point(560, 254); cards.Size = new Size(240, 120); cards.ItemHeight = 30;
        cards.Items.AddRange(new object[] { "alpha", "beta", "gamma" }); cards.AllowDrop = true;
        cards.MouseDown += delegate(object sender, MouseEventArgs e) {
            int index = cards.IndexFromPoint(e.Location);
            if (index < 0) return;
            dragItem = (string)cards.Items[index]; cards.DoDragDrop(dragItem, DragDropEffects.Move);
        };
        cards.DragEnter += delegate(object sender, DragEventArgs e) { if (e.Data.GetDataPresent(typeof(string))) e.Effect = DragDropEffects.Move; };
        cards.DragOver += delegate(object sender, DragEventArgs e) { if (e.Data.GetDataPresent(typeof(string))) e.Effect = DragDropEffects.Move; };
        cards.DragDrop += delegate(object sender, DragEventArgs e) {
            string value = e.Data.GetData(typeof(string)) as string;
            if (value != dragItem || !cards.Items.Contains(value)) return;
            int index = cards.IndexFromPoint(cards.PointToClient(new Point(e.X, e.Y)));
            cards.Items.Remove(value);
            if (index < 0 || index > cards.Items.Count) index = cards.Items.Count;
            cards.Items.Insert(index, value); dragItem = null; Record("drag", value);
        };
        Controls.Add(cards);
        var open = new Button { Name = "secondary", AccessibleName = "Open secondary fixture window", Text = "Open secondary fixture window", Location = new Point(430, 404), Size = new Size(350, 38), TabIndex = 3 };
        open.Click += delegate {
            var window = new Form { Text = "Clankie Windows Fixture secondary", ClientSize = new Size(400, 150) };
            window.Controls.Add(new Label { Text = "Secondary fixture: inventory this exact window; do not reuse primary coordinates.", Dock = DockStyle.Fill });
            secondary++; Record("secondary", secondary); window.Show(this);
        };
        Controls.Add(open);
        KeyDown += delegate(object sender, KeyEventArgs e) { Record("key", e.KeyData.ToString()); };
        Shown += delegate { ActiveControl = apply; Record("shown", "ready"); };
        FormClosing += delegate { closed = true; Record("closed", true); };
    }

    void Record(string kind, object value) {
        if (events.Count >= 4096) throw new InvalidOperationException("Fixture event limit exceeded");
        events.Add(new { index = events.Count, at = DateTime.UtcNow.ToString("O"), kind = kind, value = value });
        var state = new { schemaVersion = 1, title = Text, text = draft.Text, focused = focused, applied = applied, applies = applies,
            scroll = scroll, order = cards.Items.Cast<string>().ToArray(), secondary = secondary, closed = closed, events = events.ToArray() };
        string temp = Path.Combine(directory, "state.tmp");
        File.WriteAllText(temp, new JavaScriptSerializer().Serialize(state), new UTF8Encoding(false));
        string output = Path.Combine(directory, "state.json");
        if (File.Exists(output)) File.Replace(temp, output, null); else File.Move(temp, output);
    }

    [STAThread] static void Main(string[] args) {
        if (args.Length != 1) throw new ArgumentException("One prepared private fixture directory is required");
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ComputerFixture(args[0]));
    }
}
